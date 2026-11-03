<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { App as CapApp } from "@capacitor/app";
import type { PluginListenerHandle } from "@capacitor/core";
import TopBar from "./components/TopBar.vue";
import BottomBar from "./components/BottomBar.vue";
import type { ReaderTarget, Tab } from "./types";
import ReaderScreen from "./screens/ReaderScreen.vue";
import EpisodeListScreen from "./screens/EpisodeListScreen.vue";
import SideMenu from "./components/SideMenu.vue";
import DisplaySheet from "./components/DisplaySheet.vue";
import Icon from "./components/Icon.vue";
import HomeScreen from "./screens/HomeScreen.vue";
import BookmarksScreen from "./screens/BookmarksScreen.vue";
import HistoryScreen from "./screens/HistoryScreen.vue";
import NotificationsScreen from "./screens/NotificationsScreen.vue";
import SettingsView from "./views/SettingsView.vue";
import UsersView from "./views/UsersView.vue";
import { ApiError, deleteBookmark, errorMessage, lookupBookmark, saveBookmark } from "./api";
import type { Settings } from "./storage";
import { buildCss, type DisplaySettings } from "./display";
import { pageInfoCode, type PageInfo } from "./inject";
import { SiteView, evaluateJson } from "./native/siteView";
import { confirmNative } from "./native/dialogs";
import { externalOpenTarget, truncateUrl } from "./logic/sites";
import { ScrollHideController } from "./logic/scrollHide";
import { classifyUrl, type PageKind } from "./logic/sites";
import { bottomH, topH } from "./stores/layout";
import { toggleTheme } from "./stores/theme";
import { online, onReconnect } from "./stores/network";
import { syncNotifications, unread } from "./stores/notifications";
import { closeTopOverlay } from "./stores/overlays";
import { flushHistory, recordView } from "./stores/historySync";
import { flushReadPending } from "./stores/readProgress";

const props = defineProps<{ settings: Settings; display: DisplaySettings }>();
const emit = defineEmits<{ (e: "unauthorized"): void; (e: "logout"): void; (e: "display", d: DisplaySettings): void }>();

type Sub = "settings" | "users" | null;

const tab = ref<Tab>("home");
const sub = ref<Sub>(null);
const menuOpen = ref(false);
const displayOpen = ref(false);
const siteOpen = ref(false);
/** リーダー表示中の小説(null なら閉じている) */
const reader = ref<ReaderTarget | null>(null);
/** エピソード一覧画面で表示中の小説(null なら閉じている) */
const epList = ref<ReaderTarget | null>(null);
const readerRef = ref<InstanceType<typeof ReaderScreen> | null>(null);
/** 戻る操作で復元するスクロール位置(リーダー用)。通常は 0 */
const readerRestoreY = ref(0);
const hidden = ref(false); // バー(上下)を隠している
const toast = ref("");
/** ★ の状態。kind が null なら作品/話ページではない(無効) */
const star = ref<{ kind: PageKind["kind"] | null; bookmarked: boolean; id: number | null }>({ kind: null, bookmarked: false, id: null });

const isAdmin = computed(() => props.settings.role === "admin");
const cfg = () => ({ serverUrl: props.settings.serverUrl, token: props.settings.token });

/** ネイティブのサイト表示を見せてよい状態か(オーバーレイ/他タブ/サブ画面では隠す) */
const siteVisible = computed(() => siteOpen.value && tab.value === "home" && !sub.value && !reader.value && !epList.value && !menuOpen.value && !displayOpen.value);
const showSiteHost = computed(() => siteOpen.value && tab.value === "home" && !sub.value && !reader.value && !epList.value);
/** タブの画面(ホーム/お気に入り等)を出す状態 */
const showTabs = computed(() => !sub.value && !reader.value && !epList.value && !showSiteHost.value);
const tabComponent = computed(() => ({ home: HomeScreen, bookmarks: BookmarksScreen, history: HistoryScreen, notifications: NotificationsScreen })[tab.value]);
const starEnabled = computed(() => showSiteHost.value && star.value.kind !== null);

let curUrl = "";
let lastRecorded = "";
let pageTok = 0;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let alive = true;
const ctl = new ScrollHideController({ threshold: 8, lockMs: 250 });
const handles: PluginListenerHandle[] = [];
let offReconnect: (() => void) | null = null;

// ---------------------------------------------------------------- utilities

function showToast(msg: string) {
  toast.value = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.value = ""), 2500);
}
/** 401 は再ログインへ、それ以外はトーストに表示。 */
function fail(e: unknown) {
  if (e instanceof ApiError && e.status === 401) emit("unauthorized");
  else showToast(errorMessage(e));
}

// ---------------------------------------------------------------- bars + SiteView insets

/** SiteView の表示領域をバーの状態に合わせる(バー表示中: 上下バーの内側、非表示: 全面)。 */
function applyInsets(animate: boolean) {
  if (!siteOpen.value) return;
  const h = hidden.value;
  SiteView.setInsets({ top: h ? 0 : topH.value, bottom: h ? 0 : bottomH.value, animate }).catch(() => {});
}
function setHidden(h: boolean, animate = true) {
  if (hidden.value === h) return;
  hidden.value = h;
  if (siteVisible.value) applyInsets(animate);
}
/** バーを表示に戻す(ページ遷移・タブ切替・オーバーレイ表示時)。 */
function showBars(animate = true) {
  ctl.reset();
  setHidden(false, animate);
}

function onWindowScroll() {
  if (siteVisible.value || showSiteHost.value) return; // サイト表示中はネイティブ側のスクロールで判定
  const y = Math.max(0, window.scrollY);
  if (performance.now() < noHideUntil) {
    lastY = y; // 復元のためのスクロールではバーを隠さない
    return;
  }
  const dy = y - lastY;
  lastY = y;
  const r = ctl.feed(dy, y, performance.now());
  if (r !== null) setHidden(r);
}
let lastY = 0;
let noHideUntil = 0;
function scrollTop() {
  window.scrollTo({ top: 0, behavior: "smooth" });
}

watch(siteVisible, async (v) => {
  if (!siteOpen.value) return;
  try {
    await SiteView.setVisible({ visible: v });
  } catch {
    /* 閉じている */
  }
  if (v) {
    showBars(false);
    applyInsets(false);
    void refreshStar();
  }
});
watch([topH, bottomH], () => applyInsets(false));
// 画面遷移時のスクロール位置は、ナビゲーション関数(go / popRoute)側で設定する

// ---------------------------------------------------------------- SiteView

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/** 本文フォント CSS を注入(3 サイト以外では空なので何もしない)。同じ style 要素を置き換えるので繰り返しても安全。 */
async function injectCss(url: string) {
  const code = buildCss(hostOf(url), props.display);
  if (!code) return;
  try {
    await SiteView.insertCss({ code });
  } catch {
    /* 注入失敗はページ表示に影響させない */
  }
}
watch(
  () => props.display,
  () => {
    if (siteOpen.value) void injectCss(curUrl);
  },
  { deep: true },
);

async function refreshStar() {
  const kind = classifyUrl(curUrl);
  if (!kind) {
    star.value = { kind: null, bookmarked: false, id: null };
    return;
  }
  const tok = pageTok;
  star.value = { kind: kind.kind, bookmarked: false, id: null };
  if (!online.value) return;
  try {
    const r = await lookupBookmark(cfg(), curUrl);
    if (tok === pageTok && alive) star.value = { kind: kind.kind, bookmarked: r.bookmarked, id: r.bookmarkId };
  } catch (e) {
    if (e instanceof ApiError && e.status === 401 && alive) emit("unauthorized");
    /* それ以外(通信不可など)は未登録表示のまま */
  }
}

/** ページ読み込み完了(SPA 遷移の合成イベント含む)毎: フォント CSS・★ 状態・閲覧履歴。 */
async function onPageFinished(url: string, title: string) {
  const tok = ++pageTok;
  curUrl = url;
  if (ctl.reset()) setHidden(false, true);
  void injectCss(url);
  void refreshStar();

  const kind = classifyUrl(url);
  if (!kind || url === lastRecorded) return;
  lastRecorded = url; // 1 ページ読み込みにつき 1 回
  const info = await evaluateJson<PageInfo>(pageInfoCode());
  if (tok !== pageTok || !alive) return; // 既に別ページへ移った(次の pageFinished が記録する)
  const ok = await recordView(cfg(), {
    url: info?.url || url,
    novelTitle: info?.novelTitle || title,
    episodeTitle: kind.kind === "episode" ? (info?.episodeTitle ?? "") : "",
  });
  if (!ok && alive) emit("unauthorized");
}

async function openUrl(url: string) {
  menuOpen.value = false;
  displayOpen.value = false;
  const onSite = tab.value === "home" && siteOpen.value && !sub.value && !reader.value && !epList.value;
  if (!onSite) {
    // 今いた画面(お気に入り・履歴・リーダー等)を積んでからサイトへ。戻るとそこへ戻る
    go(() => {
      sub.value = null;
      reader.value = null;
      epList.value = null;
      tab.value = "home";
    });
  }
  showBars(false);
  try {
    if (siteOpen.value) {
      await SiteView.navigate({ url });
      await SiteView.setVisible({ visible: true });
      applyInsets(false);
    } else {
      lastRecorded = "";
      curUrl = url;
      star.value = { kind: null, bookmarked: false, id: null };
      await SiteView.open({ url, top: topH.value, bottom: bottomH.value });
      siteOpen.value = true;
    }
  } catch (e) {
    showToast(errorMessage(e));
  }
}

async function closeSite() {
  siteOpen.value = false;
  curUrl = "";
  lastRecorded = "";
  pageTok++;
  star.value = { kind: null, bookmarked: false, id: null };
  showBars(false);
  try {
    await SiteView.close();
  } catch {
    /* 既に閉じている */
  }
}

// ---------------------------------------------------------------- ★

async function onStar() {
  if (!starEnabled.value) return;
  if (star.value.bookmarked && star.value.id !== null) {
    if (!(await confirmNative("お気に入りを解除しますか?", "お気に入り", "解除"))) return;
    try {
      await deleteBookmark(cfg(), star.value.id);
      star.value = { ...star.value, bookmarked: false, id: null };
      showToast("お気に入りを解除しました");
    } catch (e) {
      fail(e);
    }
    return;
  }
  // 利用者の操作で、表示中のページの DOM から作品名等を読み取って保存する(自動取得ではない)
  const info = await evaluateJson<PageInfo>(pageInfoCode());
  if (!info) return showToast("ページ情報を取得できませんでした");
  try {
    const r = await saveBookmark(cfg(), { url: info.url, title: info.novelTitle || "(無題)", author: info.author || undefined });
    star.value = { ...star.value, bookmarked: true, id: r.bookmark.id };
    showToast(r.created ? "お気に入りに追加しました" : "登録済みです");
  } catch (e) {
    fail(e);
  }
}

// ---------------------------------------------------------------- navigation

/**
 * ナビゲーションスタック。画面(タブ + サブ画面 + リーダー)を移動する前に、今いた画面とスクロール位置を積み、
 * 戻る操作で 1 つ前の画面へ(スクロール位置も)復元する。サイト表示はホームタブ上の状態(siteOpen)で、
 * サイト内の戻りは SiteView 側の履歴、サイトを閉じたあとは このスタックで元の画面に戻る。
 */
interface Route {
  tab: Tab;
  sub: Sub;
  reader: ReaderTarget | null;
  epList: ReaderTarget | null;
  scrollY: number;
}
const MAX_STACK = 50;
const routeStack: Route[] = [];

function snapshot(): Route {
  return { tab: tab.value, sub: sub.value, reader: reader.value ? { ...reader.value } : null, epList: epList.value ? { ...epList.value } : null, scrollY: Math.max(0, window.scrollY) };
}

/** スクロール位置の復元。一覧は非同期で読み込まれるため、高さが足りるまで少し待って再試行する。 */
let restoreTimer: ReturnType<typeof setTimeout> | undefined;
function restoreScroll(y: number) {
  clearTimeout(restoreTimer);
  lastY = y;
  noHideUntil = performance.now() + 300;
  if (y <= 0) {
    window.scrollTo(0, 0);
    return;
  }
  let tries = 0;
  const step = () => {
    noHideUntil = performance.now() + 300;
    window.scrollTo(0, y);
    const reached = Math.abs(window.scrollY - y) < 2;
    if (!reached && ++tries < 80 && alive) restoreTimer = setTimeout(step, 50);
  };
  void nextTick(step);
}

/** 画面を変更する。変更前の画面をスタックへ積む。 */
function go(change: () => void) {
  routeStack.push(snapshot());
  if (routeStack.length > MAX_STACK) routeStack.shift();
  change();
  showBars(false);
  restoreScroll(0);
}

/** 1 つ前の画面へ戻る。戻れる履歴がなければ false。 */
function popRoute(): boolean {
  const r = routeStack.pop();
  if (!r) return false;
  readerRestoreY.value = r.reader ? r.scrollY : 0;
  tab.value = r.tab;
  sub.value = r.sub;
  reader.value = r.reader;
  epList.value = r.epList;
  showBars(false);
  restoreScroll(r.scrollY);
  return true;
}

function onTab(t: Tab) {
  menuOpen.value = false;
  if (t === "home" && tab.value === "home" && !sub.value && !reader.value && !epList.value && siteOpen.value) {
    void closeSite(); // ホーム再タップ: サイトを閉じる
    return;
  }
  if (t === tab.value && !sub.value && !reader.value && !epList.value) return;
  go(() => {
    sub.value = null;
    reader.value = null;
    epList.value = null;
    tab.value = t;
  });
}

function openSub(s: Exclude<Sub, null>) {
  menuOpen.value = false;
  go(() => {
    reader.value = null;
    epList.value = null;
    sub.value = s;
  });
}

/** バックアップの閲覧は お気に入り → エピソード一覧 → リーダー の順にスタックへ積む */
function openEpisodeList(target: ReaderTarget) {
  go(() => {
    sub.value = null;
    reader.value = null;
    epList.value = { ...target, episodeKey: undefined, resume: undefined };
  });
}
/** 作品選択からの「続きから読む」: 一覧を挟んで(戻ると一覧へ)リーダーを開く */
function resumeReader(target: ReaderTarget) {
  openEpisodeList(target);
  openReader({ ...target, resume: true });
}
/** 話を指定してリーダーを開く(話の指定がなければ resume の指定に従う) */
function openReader(target: ReaderTarget) {
  go(() => {
    sub.value = null;
    readerRestoreY.value = 0;
    epList.value = null;
    reader.value = { ...target };
  });
}
function openEpisode(key: string) {
  if (epList.value) openReader({ ...epList.value, episodeKey: key, resume: false });
}
/** リーダーのメニューから一覧へ。直前の画面が同じ作品の一覧なら戻る */
function toEpisodeList() {
  menuOpen.value = false;
  if (!reader.value) return;
  const prev = routeStack[routeStack.length - 1];
  const r = reader.value;
  if (prev?.epList && prev.epList.site === r.site && prev.epList.novelKey === r.novelKey) {
    popRoute();
    return;
  }
  openEpisodeList({ ...r, episodeKey: undefined });
}
/** リーダーで話が変わったとき、現在の履歴項目に反映する(戻ったときに同じ話を開く)。スタックは増やさない。 */
function onReaderEpisode(key: string) {
  if (reader.value) reader.value = { ...reader.value, episodeKey: key };
}
async function doLogout() {
  if (!(await confirmNative("ログアウトしますか?", "ログアウト", "ログアウト"))) return;
  menuOpen.value = false;
  emit("logout");
}

/** Android 戻るボタン: メニュー/シート → サブ画面 → サイト内で戻る → サイトを閉じる → ホームへ → 終了 */
async function onBack() {
  if (closeTopOverlay()) return;
  if (tab.value === "home" && siteOpen.value && !sub.value && !reader.value && !epList.value) {
    let went = false;
    try {
      went = (await SiteView.goBack()).wentBack;
    } catch {
      /* 閉じる */
    }
    if (!went) {
      await closeSite();
      popRoute(); // サイトを開く前にいた画面(お気に入り等)へ。履歴がなければホームのまま
    }
    return;
  }
  if (popRoute()) return;
  if (sub.value || reader.value || epList.value) {
    sub.value = null;
    reader.value = null;
    epList.value = null;
    return;
  }
  if (tab.value !== "home") {
    tab.value = "home";
    return;
  }
  void CapApp.exitApp();
}

let lastExternal = { url: "", at: 0 };
let externalBusy = false;
/** 許可外リンク: 自動では開かず、確認 → OK のときだけ既定ブラウザで開く。同一 URL の連続イベントは 1 秒間無視。 */
async function onExternalLink(url: string) {
  const now = Date.now();
  if (externalBusy || (url === lastExternal.url && now - lastExternal.at < 1000)) return;
  lastExternal = { url, at: now };
  externalBusy = true;
  try {
    const ok = await confirmNative(`外部サイトへのリンクです。ブラウザで開きますか?\n\n${truncateUrl(url)}`, "外部リンク");
    if (!ok) return;
    const target = externalOpenTarget(url);
    if (!target) return showToast("このリンクは開けません");
    try {
      await SiteView.openExternal({ url: target });
    } catch (e) {
      showToast(errorMessage(e));
    }
  } finally {
    externalBusy = false;
    lastExternal.at = Date.now();
  }
}

onMounted(async () => {
  window.addEventListener("scroll", onWindowScroll, { passive: true });
  handles.push(
    await SiteView.addListener("pageFinished", (e) => void onPageFinished(e.url, e.title)),
    await SiteView.addListener("scroll", (e) => {
      if (!siteVisible.value) return;
      const r = ctl.feed(e.dy, e.y, performance.now());
      if (r !== null) setHidden(r);
    }),
    await SiteView.addListener("externalLink", (e) => void onExternalLink(e.url)),
    await CapApp.addListener("backButton", () => void onBack()),
  );
  offReconnect = onReconnect(() => {
    void flushHistory(cfg());
    void syncNotifications(cfg());
    flushReadPending(cfg()).catch(() => {});
  });
  flushReadPending(cfg()).catch(() => {});
  void flushHistory(cfg());
  void syncNotifications(cfg());
});
onUnmounted(() => {
  alive = false;
  clearTimeout(toastTimer);
  window.removeEventListener("scroll", onWindowScroll);
  handles.forEach((h) => void h.remove());
  offReconnect?.();
  if (siteOpen.value) void SiteView.close();
});
</script>

<template>
  <div class="shell">
    <TopBar
      :username="settings.username"
      :hidden="hidden"
      :reader="!!reader && !sub"
      @menu="menuOpen = true"
      @display="displayOpen = true"
      @theme="toggleTheme"
      @brand="scrollTop"
      @back="onBack"
      @reader-menu="readerRef?.openMenu()"
    />

    <!-- サイト表示中: この背後(上下バーの間)にネイティブ WebView が重なる -->
    <div v-if="showSiteHost" class="site-host" />
    <main v-show="!showSiteHost" class="screen">
      <template v-if="sub">
        <div class="subhead">
          <button class="icon-btn" aria-label="戻る" @click="onBack"><Icon name="back" /></button>
          <h1>{{ sub === "settings" ? "設定" : "ユーザー管理" }}</h1>
        </div>
        <SettingsView v-if="sub === 'settings'" :settings="settings" @logout="doLogout" @unauthorized="emit('unauthorized')" />
        <UsersView v-else-if="isAdmin" :settings="settings" @unauthorized="emit('unauthorized')" />
      </template>
      <EpisodeListScreen
        v-else-if="epList"
        :key="epList.site + ':' + epList.novelKey"
        :settings="settings"
        :site="epList.site"
        :novel-key="epList.novelKey"
        :novel-title="epList.title"
        :author="epList.author"
        :prefer-offline="epList.preferOffline"
        :backup-at="epList.backupAt"
        :current-key="epList.episodeKey"
        @back="onBack"
        @open="openEpisode"
        @unauthorized="emit('unauthorized')"
      />
      <ReaderScreen
        v-else-if="reader"
        :key="reader.site + ':' + reader.novelKey"
        ref="readerRef"
        :settings="settings"
        :display="display"
        :site="reader.site"
        :novel-key="reader.novelKey"
        :novel-title="reader.title"
        :prefer-offline="reader.preferOffline"
        :backup-at="reader.backupAt"
        :initial-episode-key="reader.episodeKey"
        :resume="reader.resume"
        @episode-list="toEpisodeList"
        @episode="onReaderEpisode"
        @unauthorized="emit('unauthorized')"
      />
      <!-- お気に入りだけ KeepAlive で保持(戻ったとき一覧・検索語・位置がそのまま残る) -->
      <KeepAlive include="BookmarksScreen">
        <component :is="tabComponent" v-if="showTabs" :settings="settings" @open="openUrl" @read="openEpisodeList" @resume="resumeReader" @unauthorized="emit('unauthorized')" />
      </KeepAlive>
    </main>

    <BottomBar
      :tab="tab"
      :hidden="hidden"
      :star-enabled="starEnabled"
      :bookmarked="star.bookmarked"
      :unread="unread"
      @tab="onTab"
      @star="onStar"
    />
    <div v-if="toast" class="toast" role="status">{{ toast }}</div>

    <SideMenu :open="menuOpen" :username="settings.username" :role="settings.role" :is-admin="isAdmin" @close="menuOpen = false" @settings="openSub('settings')" @users="openSub('users')" @logout="doLogout" />
    <DisplaySheet :open="displayOpen" :display="display" @close="displayOpen = false" @change="emit('display', $event)" />
  </div>
</template>
