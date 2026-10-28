<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { App as CapApp } from "@capacitor/app";
import type { PluginListenerHandle } from "@capacitor/core";
import TopBar from "./components/TopBar.vue";
import BottomBar from "./components/BottomBar.vue";
import type { Tab } from "./types";
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
import { ScrollHideController } from "./logic/scrollHide";
import { classifyUrl, type PageKind } from "./logic/sites";
import { bottomH, topH } from "./stores/layout";
import { toggleTheme } from "./stores/theme";
import { online, onReconnect } from "./stores/network";
import { unread } from "./stores/notifications";
import { closeTopOverlay } from "./stores/overlays";
import { flushHistory, recordView } from "./stores/historySync";

const props = defineProps<{ settings: Settings; display: DisplaySettings }>();
const emit = defineEmits<{ (e: "unauthorized"): void; (e: "logout"): void; (e: "display", d: DisplaySettings): void }>();

type Sub = "settings" | "users" | null;

const tab = ref<Tab>("home");
const sub = ref<Sub>(null);
const menuOpen = ref(false);
const displayOpen = ref(false);
const siteOpen = ref(false);
const hidden = ref(false); // バー(上下)を隠している
const toast = ref("");
/** ★ の状態。kind が null なら作品/話ページではない(無効) */
const star = ref<{ kind: PageKind["kind"] | null; bookmarked: boolean; id: number | null }>({ kind: null, bookmarked: false, id: null });

const isAdmin = computed(() => props.settings.role === "admin");
const cfg = () => ({ serverUrl: props.settings.serverUrl, token: props.settings.token });

/** ネイティブのサイト表示を見せてよい状態か(オーバーレイ/他タブ/サブ画面では隠す) */
const siteVisible = computed(() => siteOpen.value && tab.value === "home" && !sub.value && !menuOpen.value && !displayOpen.value);
const showSiteHost = computed(() => siteOpen.value && tab.value === "home" && !sub.value);
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
  const dy = y - lastY;
  lastY = y;
  const r = ctl.feed(dy, y, performance.now());
  if (r !== null) setHidden(r);
}
let lastY = 0;
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
watch(tab, () => {
  showBars(false);
  lastY = 0;
  window.scrollTo(0, 0);
});
watch(sub, () => {
  showBars(false);
  lastY = 0;
  window.scrollTo(0, 0);
});

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
  sub.value = null;
  tab.value = "home";
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

function onTab(t: Tab) {
  const hadSub = sub.value !== null;
  sub.value = null;
  if (t === "home" && tab.value === "home" && !hadSub && siteOpen.value) void closeSite(); // ホーム再タップ: サイトを閉じる
  else tab.value = t;
}

function openSub(s: Exclude<Sub, null>) {
  menuOpen.value = false;
  sub.value = s;
}
async function doLogout() {
  if (!(await confirmNative("ログアウトしますか?", "ログアウト", "ログアウト"))) return;
  menuOpen.value = false;
  emit("logout");
}

/** Android 戻るボタン: メニュー/シート → サブ画面 → サイト内で戻る → サイトを閉じる → ホームへ → 終了 */
async function onBack() {
  if (closeTopOverlay()) return;
  if (sub.value) {
    sub.value = null;
    return;
  }
  if (tab.value === "home" && siteOpen.value) {
    let went = false;
    try {
      went = (await SiteView.goBack()).wentBack;
    } catch {
      /* 閉じる */
    }
    if (!went) await closeSite();
    return;
  }
  if (tab.value !== "home") {
    tab.value = "home";
    return;
  }
  void CapApp.exitApp();
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
    await CapApp.addListener("backButton", () => void onBack()),
  );
  offReconnect = onReconnect(() => void flushHistory(cfg()));
  void flushHistory(cfg());
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
    <TopBar :username="settings.username" :hidden="hidden" @menu="menuOpen = true" @display="displayOpen = true" @theme="toggleTheme" @brand="scrollTop" />

    <main v-if="sub" class="screen">
      <div class="subhead">
        <button class="icon-btn" aria-label="戻る" @click="sub = null"><Icon name="back" /></button>
        <h1>{{ sub === "settings" ? "設定" : "ユーザー管理" }}</h1>
      </div>
      <SettingsView v-if="sub === 'settings'" :settings="settings" @logout="doLogout" @unauthorized="emit('unauthorized')" />
      <UsersView v-else-if="isAdmin" :settings="settings" @unauthorized="emit('unauthorized')" />
    </main>
    <!-- サイト表示中: この背後(上下バーの間)にネイティブ WebView が重なる -->
    <div v-else-if="showSiteHost" class="site-host" />
    <main v-else class="screen">
      <HomeScreen v-if="tab === 'home'" :settings="settings" @open="openUrl" @unauthorized="emit('unauthorized')" />
      <BookmarksScreen v-else-if="tab === 'bookmarks'" :settings="settings" @open="openUrl" @unauthorized="emit('unauthorized')" />
      <HistoryScreen v-else-if="tab === 'history'" :settings="settings" @open="openUrl" @unauthorized="emit('unauthorized')" />
      <NotificationsScreen v-else />
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
