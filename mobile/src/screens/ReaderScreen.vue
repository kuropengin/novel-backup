<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from "vue";
import Icon from "../components/Icon.vue";
import type { Settings } from "../storage";
import { ApiError, NetworkError, errorMessage, listBackupEpisodes, type BackupEpisode } from "../api";
import type { SiteId } from "../logic/sites";
import { getOfflineNovel } from "../stores/offlineLibrary";
import { loadProgress, setRead } from "../stores/readProgress";
import { resumeIndex } from "../logic/readProgress";
import { FONT_SIZES_PX, fontStackOf, type DisplaySettings } from "../display";
import { pushOverlay } from "../stores/overlays";

interface ReaderEpisode {
  episodeKey: string;
  position: number;
  title: string;
  prefaceHtml: string;
  bodyHtml: string;
  afterwordHtml: string;
}

const props = defineProps<{
  settings: Settings;
  display: DisplaySettings;
  site: SiteId;
  novelKey: string;
  novelTitle: string;
  preferOffline?: boolean;
  /** 小説の最終バックアップ日時(ISO) */
  backupAt?: string | null;
  /** 開く話(戻る操作で復元するため)。なければ先頭 */
  initialEpisodeKey?: string;
  /** 話の指定がないとき、続きから(最後に読んだ話の次の未読)を開く */
  resume?: boolean;
}>();

const emit = defineEmits<{
  (e: "unauthorized"): void;
  /** 表示中の話が変わった(ナビゲーション履歴へ反映する) */
  (e: "episode", key: string): void;
  /** サイドメニューの「エピソード一覧」 */
  (e: "episode-list"): void;
}>();

const episodes = ref<ReaderEpisode[]>([]);
const loading = ref(true);
const error = ref("");
const currentIndex = ref(0);
const source = ref<"offline" | "backup">("backup");
const savedAt = ref<string | null>(null);
const menuOpen = ref(false);

const current = computed(() => episodes.value[currentIndex.value] || null);
const isFirst = computed(() => currentIndex.value <= 0);
const isLast = computed(() => currentIndex.value >= episodes.value.length - 1);

/** 配色は CSS 変数(ルートの data-theme で切り替わる)に追従し、文字サイズ・行間・フォントは表示設定から反映する */
const bodyStyle = computed(() => ({
  fontSize: `${FONT_SIZES_PX[props.display.fontSize - 1]}px`,
  lineHeight: String(props.display.lineHeight),
  fontFamily: fontStackOf(props.display.font),
}));

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "未取得";
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return "未取得";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${t.getFullYear()}/${t.getMonth() + 1}/${t.getDate()} ${p(t.getHours())}:${p(t.getMinutes())}`;
}

function mapEpisodes(list: BackupEpisode[]): ReaderEpisode[] {
  return list
    .map((ep) => ({
      episodeKey: ep.episodeKey,
      position: ep.position,
      title: ep.title,
      prefaceHtml: ep.prefaceHtml ?? "",
      bodyHtml: ep.bodyHtml,
      afterwordHtml: ep.afterwordHtml ?? "",
    }))
    .sort((a, b) => a.position - b.position);
}

const cfg = () => ({ serverUrl: props.settings.serverUrl, token: props.settings.token });

async function applyInitial() {
  let i = props.initialEpisodeKey ? episodes.value.findIndex((e) => e.episodeKey === props.initialEpisodeKey) : -1;
  if (i < 0 && props.resume) {
    try {
      const p = await loadProgress(cfg(), props.site, props.novelKey);
      i = resumeIndex(episodes.value.map((e) => e.episodeKey), new Set(p.read), p.lastReadEpisodeKey);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) emit("unauthorized");
    }
  }
  currentIndex.value = i >= 0 ? i : 0;
  // 戻る操作で復元できるよう、開いた話を履歴へ反映する
  if (current.value) emit("episode", current.value.episodeKey);
  endMarked = false;
  void nextTick(checkEnd);
}

function useOffline(offline: NonNullable<Awaited<ReturnType<typeof getOfflineNovel>>>) {
  episodes.value = mapEpisodes(offline.episodes);
  source.value = "offline";
  savedAt.value = offline.savedAt;
}

async function load() {
  loading.value = true;
  error.value = "";
  try {
    if (props.preferOffline) {
      const offline = await getOfflineNovel(props.site, props.novelKey);
      if (offline && offline.episodes.length > 0) {
        useOffline(offline);
        await applyInitial();
        return;
      }
    }
    try {
      episodes.value = mapEpisodes(await listBackupEpisodes(cfg(), props.site, props.novelKey));
      source.value = "backup";
    } catch (e) {
      // 通信できないときは端末保存分で代用する
      const offline = e instanceof NetworkError ? await getOfflineNovel(props.site, props.novelKey) : null;
      if (!offline || offline.episodes.length === 0) throw e;
      useOffline(offline);
    }
    await applyInitial();
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) emit("unauthorized");
    else error.value = errorMessage(e);
  } finally {
    loading.value = false;
    void nextTick(checkEnd);
  }
}

// 戻るボタンで閉じられるよう、メニューと一覧はオーバーレイとして登録する
let releaseMenu: (() => void) | null = null;
function openMenu() {
  if (menuOpen.value) return;
  menuOpen.value = true;
  releaseMenu = pushOverlay(() => closeMenu());
}
function closeMenu() {
  menuOpen.value = false;
  releaseMenu?.();
  releaseMenu = null;
}
function openList() {
  closeMenu();
  emit("episode-list");
}
defineExpose({ openMenu });

// 既読化: 本文の末尾までスクロールした / 「次へ」を押したとき。話ごとに 1 回だけ送る
let endMarked = false;
function markCurrentRead() {
  const ep = current.value;
  if (!ep || endMarked) return;
  endMarked = true;
  setRead(cfg(), props.site, props.novelKey, ep.episodeKey, true).catch((e) => {
    if (e instanceof ApiError && e.status === 401) emit("unauthorized");
  });
}
function checkEnd() {
  if (loading.value || !current.value || endMarked) return;
  const nearBottom = window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 160;
  if (nearBottom) markCurrentRead();
}

function show(i: number) {
  if (i < 0 || i >= episodes.value.length) return;
  currentIndex.value = i;
  endMarked = false;
  emit("episode", episodes.value[i].episodeKey);
  void nextTick(() => {
    window.scrollTo(0, 0);
    void nextTick(checkEnd); // 短くてスクロールできない話はそのまま末尾扱い
  });
}
function next() {
  markCurrentRead();
  show(currentIndex.value + 1);
}

onMounted(() => {
  window.addEventListener("scroll", checkEnd, { passive: true });
  void load();
});
onUnmounted(() => {
  window.removeEventListener("scroll", checkEnd);
  releaseMenu?.();
});
</script>

<template>
  <div class="reader">
    <div v-if="loading" class="state">読み込み中...</div>
    <div v-else-if="error" class="state err">{{ error }}</div>
    <div v-else-if="!current" class="state">表示できるエピソードがありません</div>
    <article v-else class="article" :style="bodyStyle">
      <div class="novel-title">{{ novelTitle }}</div>
      <h1 class="ep-title">{{ current.title }}</h1>
      <div class="progress">{{ currentIndex + 1 }} / {{ episodes.length }}</div>

      <div class="nav">
        <button :disabled="isFirst" @click="show(currentIndex - 1)"><Icon name="chevron-left" :size="20" />前へ</button>
        <button :disabled="isLast" @click="next">次へ<Icon name="chevron-right" :size="20" /></button>
      </div>

      <!-- 本文は改行入りプレーンテキストで保存されるため、HTML として解釈せずテキスト表示する -->
      <div v-if="current.prefaceHtml" class="body preface">{{ current.prefaceHtml }}</div>
      <div class="body">{{ current.bodyHtml }}</div>
      <div v-if="current.afterwordHtml" class="body afterword">{{ current.afterwordHtml }}</div>

      <div class="nav">
        <button :disabled="isFirst" @click="show(currentIndex - 1)"><Icon name="chevron-left" :size="20" />前へ</button>
        <button :disabled="isLast" @click="next">次へ<Icon name="chevron-right" :size="20" /></button>
      </div>
    </article>

    <!-- 右サイドメニュー -->
    <Transition name="fade">
      <div v-if="menuOpen" class="scrim" @click="closeMenu" />
    </Transition>
    <Transition name="slide-right">
      <aside v-if="menuOpen" class="reader-menu">
        <div class="rm-title">{{ novelTitle }}</div>
        <div class="menu-sep" />
        <button class="menu-item" :disabled="episodes.length === 0" @click="openList"><Icon name="book" />エピソード一覧</button>
        <div class="menu-sep" />
        <div class="rm-info">
          <div class="muted">バックアップ更新日</div>
          <div class="rm-val">{{ fmtDateTime(backupAt) }}</div>
          <template v-if="source === 'offline' && savedAt">
            <div class="muted" style="margin-top: 10px">端末保存日</div>
            <div class="rm-val">{{ fmtDateTime(savedAt) }}</div>
          </template>
        </div>
      </aside>
    </Transition>
  </div>
</template>

<style scoped>
.reader { background: var(--bg); color: var(--fg); min-height: 100vh; }
.state { padding: 64px 24px; text-align: center; color: var(--muted); }
.state.err { color: var(--danger); }
.article { padding: 8px 18px; }
.novel-title { font-size: 12px; color: var(--muted); }
.ep-title { font-size: 1.2em; margin: 4px 0 2px; font-weight: 800; color: var(--fg); }
.progress { font-size: 12px; color: var(--muted); }
.body { color: var(--fg); white-space: pre-wrap; word-wrap: break-word; overflow-wrap: anywhere; margin: 16px 0; }
.body.preface, .body.afterword { color: var(--muted); font-size: 0.9em; padding: 10px 12px; background: var(--surface); border-radius: 10px; }
.body :deep(rt) { font-size: 0.5em; line-height: 1; }
.body :deep(img) { max-width: 100%; height: auto; }
.nav { display: flex; gap: 12px; margin: 14px 0; }
.nav button { flex: 1; display: flex; align-items: center; justify-content: center; gap: 6px; padding: 12px; border: 1px solid var(--border); border-radius: 999px; background: var(--surface); color: var(--fg); font-weight: 700; }
.nav button:active:not(:disabled) { background: var(--elevated); }


.reader-menu { position: fixed; top: 0; bottom: 0; right: 0; width: min(80vw, 320px); z-index: 41; background: var(--bg); border-left: 1px solid var(--border); padding: calc(var(--sat) + 16px) 0 calc(var(--sab) + 16px); display: flex; flex-direction: column; overflow-y: auto; }
.rm-title { padding: 0 20px 6px; font-weight: 800; font-size: 16px; word-break: break-all; }
.rm-info { padding: 8px 20px; }
.rm-val { font-size: 16px; font-weight: 700; margin-top: 2px; }
.slide-right-enter-active, .slide-right-leave-active { transition: transform 0.22s ease; }
.slide-right-enter-from, .slide-right-leave-to { transform: translateX(100%); }
</style>
