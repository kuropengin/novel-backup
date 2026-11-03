<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import Icon from "../components/Icon.vue";
import type { Settings } from "../storage";
import { ApiError, NetworkError, errorMessage, listBackupEpisodes, type BackupEpisode } from "../api";
import type { SiteId } from "../logic/sites";
import { formatDate } from "../logic/lists";
import { resumeIndex } from "../logic/readProgress";
import { getOfflineNovel } from "../stores/offlineLibrary";
import { loadProgress, setRead } from "../stores/readProgress";

const props = defineProps<{
  settings: Settings;
  site: SiteId;
  novelKey: string;
  novelTitle: string;
  author?: string;
  preferOffline?: boolean;
  /** 小説の最終バックアップ日時(ISO) */
  backupAt?: string | null;
  /** 直前に開いていた話(戻ってきたとき強調する) */
  currentKey?: string;
}>();
const emit = defineEmits<{
  (e: "back"): void;
  (e: "open", episodeKey: string): void;
  (e: "unauthorized"): void;
}>();

interface Row {
  episodeKey: string;
  position: number;
  title: string;
  dateIso: string | null;
}

const rows = ref<Row[]>([]);
const loading = ref(true);
const error = ref("");
const source = ref<"offline" | "backup">("backup");
const readSet = ref<Set<string>>(new Set());
const lastReadKey = ref<string | null>(null);

const cfg = () => ({ serverUrl: props.settings.serverUrl, token: props.settings.token });

function toRows(list: BackupEpisode[]): Row[] {
  return list
    .map((e) => ({ episodeKey: e.episodeKey, position: e.position, title: e.title, dateIso: e.updatedAt ?? e.publishedAt ?? null }))
    .sort((a, b) => a.position - b.position);
}

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "未取得";
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return "未取得";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${t.getFullYear()}/${t.getMonth() + 1}/${t.getDate()} ${p(t.getHours())}:${p(t.getMinutes())}`;
}

const highlightKey = computed(() => props.currentKey ?? lastReadKey.value);
const readCount = computed(() => rows.value.filter((r) => readSet.value.has(r.episodeKey)).length);
const resumeLabel = computed(() => (readCount.value === 0 ? "最初から読む" : readCount.value >= rows.value.length ? "最初から読み直す" : "続きから読む"));

async function load() {
  loading.value = true;
  error.value = "";
  try {
    const offline = await getOfflineNovel(props.site, props.novelKey);
    if (props.preferOffline && offline && offline.episodes.length > 0) {
      rows.value = toRows(offline.episodes);
      source.value = "offline";
    } else {
      try {
        rows.value = toRows(await listBackupEpisodes(cfg(), props.site, props.novelKey));
        source.value = "backup";
      } catch (e) {
        // 通信できないときは端末保存分で代用する
        if (e instanceof NetworkError && offline && offline.episodes.length > 0) {
          rows.value = toRows(offline.episodes);
          source.value = "offline";
        } else throw e;
      }
    }
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) emit("unauthorized");
    else error.value = errorMessage(e);
    return;
  } finally {
    loading.value = false;
  }
  await refreshProgress();
}

async function refreshProgress() {
  try {
    const p = await loadProgress(cfg(), props.site, props.novelKey);
    readSet.value = new Set(p.read);
    lastReadKey.value = p.lastReadEpisodeKey;
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) emit("unauthorized");
  }
}

function resume() {
  const keys = rows.value.map((r) => r.episodeKey);
  const i = resumeIndex(keys, readSet.value, lastReadKey.value);
  if (i >= 0) emit("open", keys[i]);
}

async function toggle(r: Row) {
  const next = !readSet.value.has(r.episodeKey);
  const s = new Set(readSet.value);
  if (next) s.add(r.episodeKey);
  else s.delete(r.episodeKey);
  readSet.value = s; // 楽観的に反映
  try {
    const p = await setRead(cfg(), props.site, props.novelKey, r.episodeKey, next);
    lastReadKey.value = p.lastReadEpisodeKey;
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) emit("unauthorized");
  }
}

onMounted(load);
</script>

<template>
  <div class="eplist">
    <div class="subhead">
      <button class="icon-btn" aria-label="戻る" @click="emit('back')"><Icon name="back" /></button>
      <h1>エピソード一覧</h1>
    </div>
    <div class="head">
      <div class="nt">{{ novelTitle }}</div>
      <div v-if="author" class="au">{{ author }}</div>
      <div class="muted">バックアップ更新日: {{ fmtDateTime(backupAt) }}</div>
      <div v-if="source === 'offline'" class="muted">端末保存データを表示しています</div>
      <div v-if="rows.length > 0" class="muted">既読 {{ readCount }} / {{ rows.length }}話</div>
      <button v-if="rows.length > 0" class="btn accent resume" @click="resume"><Icon name="book" :size="18" />{{ resumeLabel }}</button>
    </div>

    <div v-if="loading" class="state">読み込み中...</div>
    <div v-else-if="error" class="state err">{{ error }}</div>
    <div v-else-if="rows.length === 0" class="state">表示できるエピソードがありません</div>
    <template v-else>
    <div
      v-for="(r, i) in rows"
      :key="r.episodeKey"
      class="row"
      :class="{ read: readSet.has(r.episodeKey), current: r.episodeKey === highlightKey }"
      role="button"
      tabindex="0"
      @click="emit('open', r.episodeKey)"
      @keydown.enter="emit('open', r.episodeKey)"
    >
      <span class="no">{{ i + 1 }}</span>
      <span class="main">
        <span class="t">{{ r.title || "(無題)" }}</span>
        <span v-if="r.dateIso" class="d">{{ formatDate(r.dateIso) }}</span>
      </span>
      <span v-if="r.episodeKey === highlightKey" class="now">{{ currentKey ? "表示中" : "最終既読" }}</span>
      <button class="tog" :class="{ on: readSet.has(r.episodeKey) }" :aria-label="readSet.has(r.episodeKey) ? '未読にする' : '既読にする'" @click.stop="toggle(r)">
        <Icon name="check" :size="18" />
        <span>{{ readSet.has(r.episodeKey) ? "既読" : "未読" }}</span>
      </button>
    </div>
    </template>
  </div>
</template>

<style scoped>
.subhead h1 { font-size: 17px; margin: 0; }
.head { padding: 12px 16px; border-bottom: 1px solid var(--border); display: flex; flex-direction: column; gap: 2px; }
.nt { font-weight: 800; font-size: 17px; word-break: break-all; }
.au { color: var(--muted); font-size: 14px; }
.resume { display: flex; align-items: center; justify-content: center; gap: 6px; margin-top: 10px; }
.state { padding: 48px 24px; text-align: center; color: var(--muted); }
.state.err { color: var(--danger); }
.row { display: flex; align-items: center; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--border); background: var(--bg); color: var(--fg); user-select: none; -webkit-user-select: none; }
.row:active { background: var(--surface); }
.no { flex: none; min-width: 2.2em; color: var(--muted); font-size: 13px; }
.main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.t { font-weight: 700; word-break: break-all; }
.d { font-size: 11px; color: var(--muted); margin-top: 2px; }
.row.read .t { font-weight: 400; color: var(--muted); }
.row.current { background: var(--surface); box-shadow: inset 3px 0 0 var(--accent); }
.now { flex: none; font-size: 11px; font-weight: 700; color: #fff; background: var(--accent); border-radius: 999px; padding: 1px 8px; }
.tog { flex: none; display: flex; align-items: center; gap: 2px; padding: 4px 8px; border: 1px solid var(--border); border-radius: 999px; background: transparent; color: var(--muted); font-size: 11px; opacity: 0.8; }
.tog.on { color: var(--accent); border-color: var(--accent); opacity: 1; }
</style>
