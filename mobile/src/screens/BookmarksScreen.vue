<script setup lang="ts">
import { computed, onActivated, onDeactivated, onMounted, onUnmounted, ref, watch } from "vue";
import Icon from "../components/Icon.vue";
import BottomSheet from "../components/BottomSheet.vue";
import BookmarkActionDialog from "../components/BookmarkActionDialog.vue";
import Pager from "../components/Pager.vue";
import SiteFilter from "../components/SiteFilter.vue";
import SwipeRow from "../components/SwipeRow.vue";
import type { ReaderTarget } from "../types";
import {
  ApiError,
  bulkBookmarks,
  deleteBookmark,
  errorMessage,
  getBackupStatus,
  listBackupEpisodes,
  listBookmarks,
  setBookmarkBackupEnabled,
  triggerBookmarksBackup,
  triggerNovelBackup,
  type Bookmark,
} from "../api";
import type { Settings } from "../storage";
import { confirmNative } from "../native/dialogs";
import { online } from "../stores/network";
import { notify } from "../stores/notifications";
import { getOfflineNovel, listOfflineNovelKeys, saveOfflineNovel } from "../stores/offlineLibrary";
import { pushOverlay } from "../stores/overlays";
import { getLocalProgress, hasPending, readVersion } from "../stores/readProgress";
import { filterBookmarks, formatDateTime, offlineOnly, sortBookmarks, SORT_OPTIONS, type SortKey, type SortOrder } from "../logic/lists";
import { siteColor, siteLabel, type SiteId } from "../logic/sites";

/** 1 ページの件数 */
const PAGE = 30;

const props = defineProps<{ settings: Settings }>();
const emit = defineEmits<{ (e: "open", url: string): void; (e: "read", target: ReaderTarget): void; (e: "resume", target: ReaderTarget): void; (e: "unauthorized"): void }>();

const items = ref<Bookmark[]>([]);
/** サーバー側の(絞り込み後の)全件数 */
const total = ref(0);
const loading = ref(true);
const error = ref("");
/** 表示中のページ(1 始まり) */
const page = ref(1);
const q = ref("");
/** サイトの絞り込み(null = すべて) */
const siteFilter = ref<SiteId | null>(null);
const sortKey = ref<SortKey>("updated");
const order = ref<SortOrder>("desc");
const sheet = ref(false);
const actionDialogOpen = ref(false);
const selectedId = ref<number | null>(null);
// 選択中の作品は最新の一覧から引き直す(バックアップ/端末保存後にダイアログも更新されるように)
const selectedBookmark = computed(() => visible.value.find((b) => b.id === selectedId.value) ?? null);
const savingOffline = ref(false);
const togglingBackup = ref(false);
const offlineKeys = ref<Set<string>>(new Set());
const backupProgress = ref("");
let statusTimer: ReturnType<typeof setInterval> | null = null;

const cfg = () => ({ serverUrl: props.settings.serverUrl, token: props.settings.token });

function handleError(e: unknown, target = error) {
  if (e instanceof ApiError && e.status === 401) emit("unauthorized");
  else target.value = errorMessage(e);
}

/** 一覧の副行に出す元サイト更新日時(無ければ空) */
function updatedLabel(b: Bookmark): string {
  return formatDateTime(b.sourceUpdatedAt);
}

/** 既読状況。未送信の変更がある作品は端末側の値を優先する */
function readInfo(b: Bookmark): { read: number; total: number; unread: number; lastKey: string | null } {
  void readVersion.value;
  const local = hasPending(b.site, b.novelKey) ? getLocalProgress(b.site, b.novelKey) : null;
  const total = b.backupEpisodeCount ?? 0;
  const read = Math.min(local ? local.read.length : (b.readEpisodeCount ?? 0), total || Infinity);
  return { read, total, unread: Math.max(0, total - read), lastKey: local ? local.lastReadEpisodeKey : (b.lastReadEpisodeKey ?? null) };
}

// 作品詳細用: 「最終既読: 第N話」。サーバーが返す話番号を使い、未送信の既読変更があるときは端末保存分の並びから求める
const episodeKeyCache = new Map<string, string[]>();
const lastReadLabel = ref("");
async function updateLastReadLabel() {
  lastReadLabel.value = "";
  const b = selectedBookmark.value;
  if (!actionDialogOpen.value || !b) return;
  const lastKey = readInfo(b).lastKey;
  if (!lastKey) return;
  if (lastKey === b.lastReadEpisodeKey && b.lastReadPosition) {
    lastReadLabel.value = `第${b.lastReadPosition}話`;
    return;
  }
  const id = `${b.site}:${b.novelKey}`;
  let keys = episodeKeyCache.get(id);
  if (!keys) {
    try {
      const off = await getOfflineNovel(b.site, b.novelKey);
      keys = off ? [...off.episodes].sort((x, y) => x.position - y.position).map((e) => e.episodeKey) : [];
      if (keys.length > 0) episodeKeyCache.set(id, keys);
    } catch {
      return; // 表示できなくても致命的ではない
    }
  }
  const i = keys.indexOf(lastKey);
  if (i >= 0 && selectedBookmark.value?.id === b.id) lastReadLabel.value = `第${i + 1}話`;
}
watch([actionDialogOpen, selectedId, readVersion], () => void updateLastReadLabel());
const selectedRead = computed(() => (selectedBookmark.value ? { ...readInfo(selectedBookmark.value), lastLabel: lastReadLabel.value } : null));

// オンライン時はサーバーで絞り込み・並べ替え済み。オフライン時は読み込み済みのうち端末保存分だけを端末内で絞り込む
const visible = computed(() => {
  const enriched = items.value.map((b) => ({
    ...b,
    updatedAt: b.lastBackupAllAt ?? b.lastBackupMetadataAt ?? b.createdAt,
    offlineSaved: offlineKeys.value.has(`${b.site}:${b.novelKey}`),
  }));
  if (online.value) return enriched;
  const bySite = siteFilter.value ? offlineOnly(enriched).filter((b) => b.site === siteFilter.value) : offlineOnly(enriched);
  return sortBookmarks(filterBookmarks(bySite, q.value), sortKey.value, order.value);
});
const countLabel = computed(() => (online.value ? total.value : visible.value.length));
const pageCount = computed(() => Math.max(1, Math.ceil(total.value / PAGE)));
const sortLabel = computed(() => `${SORT_OPTIONS.find((o) => o.key === sortKey.value)?.label ?? ""}${order.value === "desc" ? " ↓" : " ↑"}`);

// 検索語・並び順・ページが変わったら古い応答を捨てる
let seq = 0;
/** 表示中のページを取得する。silent は戻ってきたとき・操作後の更新用(表示を消さない) */
async function load(silent = false) {
  const my = ++seq;
  if (!silent) loading.value = true;
  error.value = "";
  try {
    const r = await listBookmarks(cfg(), {
      q: q.value,
      site: siteFilter.value ?? undefined,
      sort: sortKey.value,
      order: order.value,
      limit: PAGE,
      offset: (page.value - 1) * PAGE,
    });
    if (my !== seq) return;
    // 削除などで今のページが無くなったら最後のページを出す
    if (r.bookmarks.length === 0 && r.total > 0 && page.value > 1) {
      page.value = Math.ceil(r.total / PAGE);
      return void load(silent);
    }
    items.value = r.bookmarks;
    total.value = r.total;
  } catch (e) {
    if (my === seq) handleError(e);
  } finally {
    if (my === seq) loading.value = false;
  }
}

/** 条件(検索語・サイト・並び順)を変えたら 1 ページ目から */
function reloadFromFirst() {
  page.value = 1;
  void load();
}
function goPage(p: number) {
  page.value = p;
  window.scrollTo(0, 0);
  void load();
}

onMounted(() => void load());
onMounted(async () => {
  offlineKeys.value = await listOfflineNovelKeys();
});
let qTimer: ReturnType<typeof setTimeout> | undefined;
watch(q, () => {
  if (!online.value) return; // オフライン時は端末内で絞り込む
  clearTimeout(qTimer);
  qTimer = setTimeout(reloadFromFirst, 300);
});
watch([sortKey, order, siteFilter], () => {
  if (online.value) reloadFromFirst();
});
// オフライン中に変えた検索語・並び順を、復帰したらサーバー側の結果に反映する
watch(online, (on) => {
  if (on) void load(true);
});
// KeepAlive で保持されるため、戻ってきたとき(リーダー等で既読が変わった後)に件数を取り直す
let firstActivation = true;
onActivated(() => {
  if (firstActivation) {
    firstActivation = false;
    return;
  }
  void load(true);
  void listOfflineNovelKeys().then((k) => (offlineKeys.value = k));
});
onDeactivated(() => (selecting.value = false));
onUnmounted(() => {
  if (statusTimer) clearInterval(statusTimer);
  clearTimeout(qTimer);
  releaseSelection?.();
});

/** 一覧上の作品を差し替える(サーバーの応答や一括操作の結果を反映) */
function patchItems(ids: ReadonlySet<number>, patch: Partial<Bookmark>) {
  items.value = items.value.map((b) => (ids.has(b.id) ? { ...b, ...patch } : b));
}
/** 削除後: 消した行をすぐ外し、空いた分を次のページから詰めるために今のページを取り直す */
async function afterRemove(ids: ReadonlySet<number>) {
  items.value = items.value.filter((b) => !ids.has(b.id));
  await load(true);
}

async function remove(b: Bookmark) {
  if (!(await confirmNative(`「${b.title || b.novelKey}」をお気に入りから削除しますか?`, "削除", "削除"))) return;
  try {
    await deleteBookmark(cfg(), b.id);
    await afterRemove(new Set([b.id]));
  } catch (e) {
    handleError(e);
  }
}

async function toggleBackup(b: Bookmark, enabled: boolean) {
  if (togglingBackup.value) return;
  togglingBackup.value = true;
  try {
    const updated = await setBookmarkBackupEnabled(cfg(), b.id, enabled);
    patchItems(new Set([b.id]), { backupEnabled: updated.backupEnabled ?? enabled });
  } catch (e) {
    handleError(e);
  } finally {
    togglingBackup.value = false;
  }
}

function openActionDialog(b: Bookmark) {
  selectedId.value = b.id;
  actionDialogOpen.value = true;
}

async function backupNow(b: Bookmark) {
  try {
    await triggerNovelBackup(cfg(), b.site, b.novelKey);
    notify({ kind: "backup-triggered", title: "即時バックアップを開始しました", body: `${b.title || b.novelKey}` });
    startStatusPolling();
    await load(true);
  } catch (e) {
    handleError(e);
  }
}

function startStatusPolling() {
  if (statusTimer) clearInterval(statusTimer);
  statusTimer = setInterval(async () => {
    try {
      const status = await getBackupStatus(cfg());
      const t = status.taskStats;
      backupProgress.value = status.running
        ? `進捗: 待機${t.pending} / 実行中${t.inProgress} / 完了${t.completed} / 失敗${t.failed}`
        : "";
      if (!status.running && statusTimer) {
        clearInterval(statusTimer);
        statusTimer = null;
        void load(true); // バックアップ完了後に最新のバックアップ状態を反映
      }
    } catch {
      if (statusTimer) {
        clearInterval(statusTimer);
        statusTimer = null;
      }
      backupProgress.value = "";
    }
  }, 2500);
}

// ---- 複数選択(長押しまたは「選択」で開始。戻る操作で終了) ----
const selecting = ref(false);
const picked = ref<Set<number>>(new Set());
const bulkBusy = ref(false);
let releaseSelection: (() => void) | null = null;
watch(selecting, (on) => {
  releaseSelection?.();
  releaseSelection = on ? pushOverlay(() => (selecting.value = false)) : null;
  if (!on) picked.value = new Set();
});
const pickedCount = computed(() => picked.value.size);
const allPicked = computed(() => visible.value.length > 0 && visible.value.every((b) => picked.value.has(b.id)));

function startSelection(b?: Bookmark) {
  selecting.value = true;
  picked.value = new Set(b ? [b.id] : []);
}
function togglePick(b: Bookmark) {
  const s = new Set(picked.value);
  if (s.has(b.id)) s.delete(b.id);
  else s.add(b.id);
  picked.value = s;
}
function togglePickAll() {
  picked.value = allPicked.value ? new Set() : new Set(visible.value.map((b) => b.id));
}
function onRowTap(b: Bookmark) {
  if (selecting.value) togglePick(b);
  else openActionDialog(b);
}
function onRowLong(b: Bookmark) {
  if (selecting.value) togglePick(b);
  else startSelection(b);
}

/** 一括操作の共通処理: 実行中は二重に押せないようにし、成功したら選択を終える */
async function runBulk(job: (ids: number[]) => Promise<void>) {
  const ids = [...picked.value];
  if (ids.length === 0 || bulkBusy.value) return;
  bulkBusy.value = true;
  try {
    await job(ids);
    selecting.value = false;
  } catch (e) {
    handleError(e);
  } finally {
    bulkBusy.value = false;
  }
}

function bulkBackupNow() {
  void runBulk(async (ids) => {
    const n = await triggerBookmarksBackup(cfg(), ids);
    notify({ kind: "backup-triggered", title: "即時バックアップを開始しました", body: `${n}作品` });
    startStatusPolling();
  });
}

function bulkSetBackup(enabled: boolean) {
  void runBulk(async (ids) => {
    await bulkBookmarks(cfg(), { action: "setBackupEnabled", ids, enabled });
    patchItems(new Set(ids), { backupEnabled: enabled });
  });
}

async function bulkRemove() {
  const n = picked.value.size;
  if (n === 0 || !(await confirmNative(`選択した ${n} 件をお気に入りから削除しますか?`, "削除", "削除"))) return;
  void runBulk(async (ids) => {
    await bulkBookmarks(cfg(), { action: "delete", ids });
    await afterRemove(new Set(ids));
  });
}

function readerTarget(preferOffline: boolean): ReaderTarget | null {
  if (!selectedBookmark.value) return null;
  const site = selectedBookmark.value.site;
  if (site !== "hameln" && site !== "narou" && site !== "kakuyomu") {
    error.value = "不明なサイト種別のためリーダーを開けません";
    return null;
  }
  return {
    site,
    novelKey: selectedBookmark.value.novelKey,
    title: selectedBookmark.value.title || selectedBookmark.value.novelKey,
    author: selectedBookmark.value.author || undefined,
    preferOffline,
    backupAt: selectedBookmark.value.lastBackupAllAt ?? null,
  };
}

// エピソード一覧・リーダーは Shell のナビゲーションスタックで開く(戻る操作でこの一覧に戻れる)
function openEpisodeList(preferOffline = false) {
  const t = readerTarget(preferOffline);
  if (t) emit("read", t);
}
function resumeReading(preferOffline = false) {
  const t = readerTarget(preferOffline);
  if (t) emit("resume", t);
}

async function downloadToDevice() {
  if (!selectedBookmark.value || savingOffline.value) return;
  const b = selectedBookmark.value;
  savingOffline.value = true;
  try {
    const episodes = await listBackupEpisodes(cfg(), b.site, b.novelKey);
    await saveOfflineNovel({
      site: b.site,
      novelKey: b.novelKey,
      title: b.title || b.novelKey,
      author: b.author || "",
      episodes,
    });
    offlineKeys.value = await listOfflineNovelKeys();
    notify({
      kind: "offline-saved",
      title: "端末保存が完了しました",
      body: `${b.title || b.novelKey} (${episodes.length}話)`,
    });
  } catch (e) {
    handleError(e);
  } finally {
    savingOffline.value = false;
  }
}

function pick(key: SortKey) {
  if (key === sortKey.value) order.value = order.value === "desc" ? "asc" : "desc";
  else {
    sortKey.value = key;
    order.value = key === "title" || key === "site" ? "asc" : "desc";
  }
}
</script>

<template>
  <div>
    <SiteFilter v-model="siteFilter" />
    <label class="searchbox">
      <Icon name="search" :size="18" />
      <input v-model="q" type="search" placeholder="タイトル・作者・サイトで検索" autocapitalize="off" />
    </label>
    <div v-if="selecting" class="toolbar">
      <span class="picked">{{ pickedCount }} 件選択</span>
      <div class="row">
        <button class="btn secondary small" @click="togglePickAll">{{ allPicked ? "選択解除" : "表示中をすべて選択" }}</button>
        <button class="btn secondary small" @click="selecting = false">完了</button>
      </div>
    </div>
    <div v-else class="toolbar">
      <span class="muted">{{ countLabel }} 件</span>
      <div class="row">
        <button class="btn secondary small" :disabled="!online || visible.length === 0" @click="startSelection()">選択</button>
        <button class="btn secondary small sort-btn" @click="sheet = true"><Icon name="sort" :size="16" />{{ sortLabel }}</button>
      </div>
    </div>
    <div v-if="!online" class="banner">オフライン中: 読み込み済みの作品のうち、端末保存済みのものだけを表示します。</div>
    <div v-if="backupProgress" class="banner info">{{ backupProgress }}</div>
    <p v-if="error" class="error page">{{ error }}</p>

    <div v-if="!loading && visible.length === 0 && !error" class="empty">
      <template v-if="!online">
        <div class="big">オフライン保存された作品はありません</div>
        オンライン時に「端末に保存する」を実行してください。
      </template>
      <template v-else-if="!q">
        <div class="big">お気に入りはまだありません</div>
        作品のページを開いて、下の ★ ボタンで追加できます。
      </template>
      <template v-else><div class="big">一致する作品がありません</div></template>
    </div>

    <SwipeRow v-for="b in visible" :key="b.id" @tap="onRowTap(b)" @long="onRowLong(b)">
      <div class="list-row" :class="{ picked: selecting && picked.has(b.id) }" role="button" tabindex="0" @keydown.enter="onRowTap(b)">
        <span v-if="selecting" class="check" :class="{ on: picked.has(b.id) }"><Icon v-if="picked.has(b.id)" name="check" :size="16" /></span>
        <div class="main">
          <div class="title"><span class="site-badge" :style="{ background: siteColor(b.site) }">{{ siteLabel(b.site) }}</span>{{ b.title || b.novelKey }}</div>
          <div v-if="updatedLabel(b) || readInfo(b).total > 0" class="sub">
            <template v-if="updatedLabel(b)">更新 {{ updatedLabel(b) }}</template><span v-if="readInfo(b).total > 0" class="prog" :class="{ done: readInfo(b).unread === 0 }">{{ updatedLabel(b) ? " ・ " : "" }}{{ readInfo(b).read }}/{{ readInfo(b).total }}話</span>
          </div>
        </div>
        <!-- 未読話数 / 自動バックアップ / バックアップ / オフライン保存の状態 -->
        <div class="status">
          <span v-if="readInfo(b).unread > 0" class="unread">未読 {{ readInfo(b).unread }}</span>
          <span v-if="b.backupEnabled === false" class="auto-off" title="自動バックアップ: オフ">自動OFF</span>
          <span class="st" :title="`バックアップ: ${b.lastBackupAllAt ? 'あり' : 'なし'}`" :class="{ active: !!b.lastBackupAllAt }"><Icon name="cloud" :size="20" /></span>
          <span class="st" :title="`オフライン保存: ${b.offlineSaved ? 'あり' : 'なし'}`" :class="{ active: !!b.offlineSaved }"><Icon name="download" :size="20" /></span>
        </div>
      </div>
    </SwipeRow>
    <Pager v-if="online && items.length > 0" :page="page" :page-count="pageCount" :disabled="loading" @change="goPage" />

    <!-- 複数選択中の操作(下のタブバーの上に重ねる) -->
    <div v-if="selecting" class="select-bar">
      <button :disabled="pickedCount === 0 || bulkBusy" @click="bulkBackupNow"><Icon name="refresh" :size="20" /><span>バックアップ</span></button>
      <button :disabled="pickedCount === 0 || bulkBusy" @click="bulkSetBackup(true)"><Icon name="cloud" :size="20" /><span>自動ON</span></button>
      <button :disabled="pickedCount === 0 || bulkBusy" @click="bulkSetBackup(false)"><Icon name="cloud" :size="20" /><span>自動OFF</span></button>
      <button class="danger" :disabled="pickedCount === 0 || bulkBusy" @click="bulkRemove"><Icon name="trash" :size="20" /><span>削除</span></button>
    </div>

    <BookmarkActionDialog
      :open="actionDialogOpen"
      :bookmark="selectedBookmark"
      :read-info="selectedRead"
      :toggling-backup="togglingBackup"
      @close="actionDialogOpen = false"
      @open-page="() => selectedBookmark && emit('open', selectedBookmark.url)"
      @open-reader="() => openEpisodeList(!online)"
      @resume="() => resumeReading(!online)"
      @download="downloadToDevice"
      @backup-now="() => selectedBookmark && void backupNow(selectedBookmark)"
      @remove="() => selectedBookmark && remove(selectedBookmark)"
      @toggle-backup="(enabled) => selectedBookmark && void toggleBackup(selectedBookmark, enabled)"
    />

    <BottomSheet :open="sheet" title="並べ替え" @close="sheet = false">
      <button v-for="o in SORT_OPTIONS" :key="o.key" class="sheet-option" :class="{ active: sortKey === o.key }" @click="pick(o.key)">
        <span>{{ o.label }}<span v-if="o.note" class="note">{{ o.note }}</span></span>
        <span v-if="sortKey === o.key">{{ order === "desc" ? "降順 ↓" : "昇順 ↑" }}</span>
      </button>
      <p class="muted">同じ項目をもう一度選ぶと昇順・降順が切り替わります。</p>
    </BottomSheet>
  </div>
</template>

<style scoped>
.unread { align-self: center; font-size: 11px; font-weight: 700; color: #fff; background: var(--accent); border-radius: 999px; padding: 1px 8px; white-space: nowrap; }
.auto-off { align-self: center; font-size: 11px; font-weight: 700; color: var(--muted); border: 1px solid var(--border); border-radius: 999px; padding: 0 7px; white-space: nowrap; }
.prog { white-space: pre; }
.prog.done { color: var(--accent); }
/* 状態アイコン: 未実施は薄く、実施済みはアクセント色で表示 */
.status .st { color: var(--muted); opacity: 0.35; }
.status .st.active { color: var(--accent); opacity: 1; }

.toolbar .row { display: flex; gap: 6px; }
.picked { font-weight: 800; }
.list-row { cursor: pointer; touch-action: manipulation; }
.list-row.picked { background: var(--surface); }
.check { flex: none; align-self: center; width: 22px; height: 22px; border-radius: 50%; border: 2px solid var(--border); display: inline-flex; align-items: center; justify-content: center; color: #fff; }
.check.on { background: var(--accent); border-color: var(--accent); }
.select-bar { position: fixed; left: 0; right: 0; bottom: 0; z-index: 25; height: calc(var(--bottom-h) + var(--sab)); padding: 0 4px var(--sab); display: grid; grid-template-columns: repeat(4, 1fr); align-items: center; background: var(--elevated); border-top: 1px solid var(--border); }
.select-bar button { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; height: 100%; border: 0; background: none; color: var(--fg); font-size: 11px; font-weight: 700; }
.select-bar button.danger { color: var(--danger); }
.select-bar button:disabled { opacity: 0.4; }

.banner.info {
  margin-top: 8px;
  background: #e9f4ff;
  color: #0f4f84;
}
</style>
