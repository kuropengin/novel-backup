<script setup lang="ts">
import { computed, onActivated, onMounted, onUnmounted, ref, watch } from "vue";
import Icon from "../components/Icon.vue";
import BottomSheet from "../components/BottomSheet.vue";
import BookmarkActionDialog from "../components/BookmarkActionDialog.vue";
import type { ReaderTarget } from "../types";
import { ApiError, deleteBookmark, errorMessage, getBackupStatus, listBackupEpisodes, listBookmarks, triggerNovelBackup, type Bookmark } from "../api";
import type { Settings } from "../storage";
import { confirmNative } from "../native/dialogs";
import { online } from "../stores/network";
import { notify } from "../stores/notifications";
import { getOfflineNovel, listOfflineNovelKeys, saveOfflineNovel } from "../stores/offlineLibrary";
import { getLocalProgress, hasPending, readVersion } from "../stores/readProgress";
import { filterBookmarks, offlineOnly, sortBookmarks, SORT_OPTIONS, type SortKey, type SortOrder } from "../logic/lists";
import { siteColor, siteLabel, type SiteId } from "../logic/sites";

const props = defineProps<{ settings: Settings }>();
const emit = defineEmits<{ (e: "open", url: string): void; (e: "read", target: ReaderTarget): void; (e: "resume", target: ReaderTarget): void; (e: "unauthorized"): void }>();

const items = ref<Bookmark[]>([]);
const loading = ref(true);
const error = ref("");
const q = ref("");
const sortKey = ref<SortKey>("updated");
const order = ref<SortOrder>("desc");
const sheet = ref(false);
const actionDialogOpen = ref(false);
const selectedId = ref<number | null>(null);
// 選択中の作品は最新の一覧から引き直す(バックアップ/端末保存後にダイアログも更新されるように)
const selectedBookmark = computed(() => visible.value.find((b) => b.id === selectedId.value) ?? null);
const savingOffline = ref(false);
const offlineKeys = ref<Set<string>>(new Set());
const backupProgress = ref("");
let statusTimer: ReturnType<typeof setInterval> | null = null;

const cfg = () => ({ serverUrl: props.settings.serverUrl, token: props.settings.token });

/** 既読状況。未送信の変更がある作品は端末側の値を優先する */
function readInfo(b: Bookmark): { read: number; total: number; unread: number; lastKey: string | null } {
  void readVersion.value;
  const local = hasPending(b.site, b.novelKey) ? getLocalProgress(b.site, b.novelKey) : null;
  const total = b.backupEpisodeCount ?? 0;
  const read = Math.min(local ? local.read.length : (b.readEpisodeCount ?? 0), total || Infinity);
  return { read, total, unread: Math.max(0, total - read), lastKey: local ? local.lastReadEpisodeKey : (b.lastReadEpisodeKey ?? null) };
}

// 作品選択ダイアログ用: 「最終既読: 第N話」。話の並びは端末保存分 → バックアップの順に調べ、作品ごとに記憶する
const episodeKeyCache = new Map<string, string[]>();
const lastReadLabel = ref("");
async function updateLastReadLabel() {
  lastReadLabel.value = "";
  const b = selectedBookmark.value;
  if (!actionDialogOpen.value || !b) return;
  const lastKey = readInfo(b).lastKey;
  if (!lastKey) return;
  const id = `${b.site}:${b.novelKey}`;
  let keys = episodeKeyCache.get(id);
  if (!keys) {
    try {
      const off = await getOfflineNovel(b.site, b.novelKey);
      const list = off && off.episodes.length > 0 ? off.episodes : online.value ? await listBackupEpisodes(cfg(), b.site, b.novelKey) : [];
      keys = [...list].sort((x, y) => x.position - y.position).map((e) => e.episodeKey);
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

const visible = computed(() => {
  const enriched = items.value.map((b) => ({
    ...b,
    updatedAt: b.lastBackupAllAt ?? b.lastBackupMetadataAt ?? b.createdAt,
    offlineSaved: offlineKeys.value.has(`${b.site}:${b.novelKey}`),
  }));
  const base = online.value ? enriched : offlineOnly(enriched);
  return sortBookmarks(filterBookmarks(base, q.value), sortKey.value, order.value);
});
const sortLabel = computed(() => `${SORT_OPTIONS.find((o) => o.key === sortKey.value)?.label ?? ""}${order.value === "desc" ? " ↓" : " ↑"}`);

async function load(silent = false) {
  if (!silent) loading.value = true;
  error.value = "";
  try {
    items.value = await listBookmarks(cfg());
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) emit("unauthorized");
    else error.value = errorMessage(e);
  } finally {
    loading.value = false;
  }
}
onMounted(() => void load());
onMounted(async () => {
  offlineKeys.value = await listOfflineNovelKeys();
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
onUnmounted(() => {
  if (statusTimer) clearInterval(statusTimer);
});

async function remove(b: Bookmark) {
  if (!(await confirmNative(`「${b.title || b.novelKey}」をお気に入りから削除しますか?`, "削除", "削除"))) return;
  try {
    await deleteBookmark(cfg(), b.id);
    items.value = items.value.filter((x) => x.id !== b.id);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) emit("unauthorized");
    else error.value = errorMessage(e);
  }
}

function openActionDialog(b: Bookmark & { offlineSaved?: boolean }) {
  selectedId.value = b.id;
  actionDialogOpen.value = true;
}

function handleActionDialogBackupNow(b: Bookmark) {
  void backupNow(b);
}

async function backupNow(b: Bookmark) {
  try {
    await triggerNovelBackup(cfg(), b.site, b.novelKey);
    notify({ kind: "backup-triggered", title: "即時バックアップを開始しました", body: `${b.title || b.novelKey}` });
    startStatusPolling();
    await load();
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) emit("unauthorized");
    else error.value = errorMessage(e);
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
        void load(); // バックアップ完了後に最新のバックアップ状態を反映
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
    if (e instanceof ApiError && e.status === 401) emit("unauthorized");
    else error.value = errorMessage(e);
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
    <label class="searchbox">
      <Icon name="search" :size="18" />
      <input v-model="q" type="search" placeholder="タイトル・作者・サイトで検索" autocapitalize="off" />
    </label>
    <div class="toolbar">
      <span class="muted">{{ visible.length }} 件</span>
      <button class="btn secondary small sort-btn" @click="sheet = true"><Icon name="sort" :size="16" />{{ sortLabel }}</button>
    </div>
    <div v-if="!online" class="banner">オフライン中: 端末保存済みの作品のみ表示します。</div>
    <div v-if="backupProgress" class="banner info">{{ backupProgress }}</div>
    <p v-if="error" class="error page">{{ error }}</p>

    <div v-if="!loading && visible.length === 0 && !error" class="empty">
      <template v-if="!online">
        <div class="big">オフライン保存された作品はありません</div>
        オンライン時に「端末に保存する」を実行してください。
      </template>
      <template v-else-if="items.length === 0">
        <div class="big">お気に入りはまだありません</div>
        作品のページを開いて、下の ★ ボタンで追加できます。
      </template>
      <template v-else><div class="big">一致する作品がありません</div></template>
    </div>

    <div v-for="b in visible" :key="b.id">
      <div class="list-row" role="button" tabindex="0" style="touch-action: manipulation; cursor: pointer" @click="openActionDialog(b)" @keydown.enter="openActionDialog(b)">
        <div class="main">
          <div class="title"><span class="site-badge" :style="{ background: siteColor(b.site) }">{{ siteLabel(b.site) }}</span>{{ b.title || b.novelKey }}</div>
          <div v-if="b.author || readInfo(b).total > 0" class="sub">
            {{ b.author }}<span v-if="readInfo(b).total > 0" class="prog" :class="{ done: readInfo(b).unread === 0 }">{{ b.author ? " ・ " : "" }}{{ readInfo(b).read }}/{{ readInfo(b).total }}話</span>
          </div>
        </div>
        <!-- 未読話数 / バックアップ / オフライン保存の状態 -->
        <div class="status">
          <span v-if="readInfo(b).unread > 0" class="unread">未読 {{ readInfo(b).unread }}</span>
          <span class="st" :title="`バックアップ: ${b.lastBackupAllAt ? 'あり' : 'なし'}`" :class="{ active: !!b.lastBackupAllAt }"><Icon name="cloud" :size="20" /></span>
          <span class="st" :title="`オフライン保存: ${b.offlineSaved ? 'あり' : 'なし'}`" :class="{ active: !!b.offlineSaved }"><Icon name="download" :size="20" /></span>
        </div>
      </div>
    </div>

    <BookmarkActionDialog
      :open="actionDialogOpen"
      :bookmark="selectedBookmark"
      :read-info="selectedRead"
      @close="actionDialogOpen = false"
      @open-page="() => selectedBookmark && emit('open', selectedBookmark.url)"
      @open-reader="() => openEpisodeList(!online)"
      @resume="() => resumeReading(!online)"
      @download="downloadToDevice"
      @backup-now="() => selectedBookmark && handleActionDialogBackupNow(selectedBookmark)"
      @remove="() => selectedBookmark && remove(selectedBookmark)"
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
.prog { white-space: pre; }
.prog.done { color: var(--accent); }
/* 状態アイコン: 未実施は薄く、実施済みはアクセント色で表示 */
.status .st { color: var(--muted); opacity: 0.35; }
.status .st.active { color: var(--accent); opacity: 1; }

.reader-overlay {
  position: fixed;
  inset: 0;
  z-index: 70;
  background: #fff;
}

.banner.info {
  margin-top: 8px;
  background: #e9f4ff;
  color: #0f4f84;
}
</style>
