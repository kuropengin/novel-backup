<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { backupsApi, bookmarksApi } from "../api";
import { errorMessage } from "../api/client";
import type { BackupEpisodeResponse, EpisodeVersionBody } from "../api/types";
import DiffView from "../components/DiffView.vue";
import EpisodeReader from "../components/EpisodeReader.vue";
import { fmtDateTime, htmlToPlain } from "../composables/format";

const route = useRoute();
const router = useRouter();
const data = ref<BackupEpisodeResponse | null>(null);
const error = ref("");
const loading = ref(false);

const novelId = computed(() => Number(route.params.novelId));
const episodeId = computed(() => Number(route.params.episodeId));
/** URL の ?v= で版を指定(省略 = 最新) */
const wantedVersion = computed(() => {
  const v = Number(route.query.v);
  return Number.isInteger(v) && v > 0 ? v : undefined;
});

const showDiff = ref(false);
const baseVersion = ref<number | null>(null);
const baseBody = ref<EpisodeVersionBody | null>(null);
const diffError = ref("");

async function load() {
  loading.value = true;
  error.value = "";
  data.value = null;
  baseBody.value = null;
  try {
    const r = await backupsApi.episode(novelId.value, episodeId.value, wantedVersion.value);
    data.value = r;
    baseVersion.value = r.versions.length > 1 ? (r.versions.find((v) => v.version === r.version.version - 1)?.version ?? r.versions[0]!.version) : null;
    await nextTick();
    window.scrollTo(0, 0);
    // 最新版を開いたとき、ブックマーク済みなら最後に読んだ話を更新(失敗しても閲覧は継続)
    if (!wantedVersion.value && r.episode.removedAt === null) markRead(r.novel.id, r.episode.episodeKey);
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    loading.value = false;
  }
}
async function markRead(nid: number, episodeKey: string) {
  try {
    const b = (await bookmarksApi.list()).bookmarks.find((x) => x.novelId === nid);
    if (b) await bookmarksApi.update(b.id, { lastReadEpisodeKey: episodeKey });
  } catch {
    /* ignore */
  }
}
watch(() => [novelId.value, episodeId.value, wantedVersion.value], load, { immediate: true });

async function loadBase() {
  baseBody.value = null;
  diffError.value = "";
  if (!showDiff.value || baseVersion.value === null || !data.value) return;
  try {
    baseBody.value = (await backupsApi.episode(novelId.value, episodeId.value, baseVersion.value)).version;
  } catch (e) {
    diffError.value = errorMessage(e);
  }
}
watch([showDiff, baseVersion, () => data.value?.version.version], loadBase);

function plain(v: EpisodeVersionBody): string {
  return [v.title, htmlToPlain(v.prefaceHtml), htmlToPlain(v.bodyHtml), htmlToPlain(v.afterwordHtml)].filter((x) => x).join("\n\n");
}
const oldText = computed(() => (baseBody.value ? plain(baseBody.value) : ""));
const newText = computed(() => (data.value ? plain(data.value.version) : ""));

const latestVersion = computed(() => data.value?.versions[data.value.versions.length - 1]?.version ?? 1);
function selectVersion(v: number) {
  router.replace({ query: v === latestVersion.value ? {} : { v: String(v) } });
}
function epRoute(id: number) {
  return { name: "backup-episode", params: { novelId: novelId.value, episodeId: id } };
}
const tocRoute = computed(() => ({ name: "backup-novel", params: { novelId: novelId.value } }));
</script>

<template>
  <div class="ep-page">
    <p v-if="loading" class="muted">読み込み中…</p>
    <div v-if="error" class="card">
      <p class="error">{{ error }}</p>
      <RouterLink :to="tocRoute">目次へ戻る</RouterLink>
    </div>
    <template v-if="data">
      <div class="card vbar">
        <label>
          版
          <select :value="data.version.version" @change="selectVersion(Number(($event.target as HTMLSelectElement).value))">
            <option v-for="v in [...data.versions].reverse()" :key="v.version" :value="v.version">
              v{{ v.version }}{{ v.version === latestVersion ? "(最新)" : "" }} - 取得 {{ fmtDateTime(v.fetchedAt) }}
            </option>
          </select>
        </label>
        <template v-if="data.versions.length > 1">
          <button class="small" :class="{ secondary: !showDiff }" @click="showDiff = !showDiff">
            {{ showDiff ? "差分を閉じる" : "差分を見る" }}
          </button>
          <label v-if="showDiff">
            比較元
            <select v-model.number="baseVersion">
              <option v-for="v in data.versions.filter((x) => x.version !== data!.version.version)" :key="v.version" :value="v.version">
                v{{ v.version }}({{ fmtDateTime(v.fetchedAt) }})
              </option>
            </select>
          </label>
        </template>
        <span v-if="data.episode.removedAt" class="badge del">サイトから削除済み</span>
        <span class="muted">
          v{{ data.version.version }} / サイト更新: {{ fmtDateTime(data.version.siteUpdatedAt, "不明") }}
        </span>
      </div>

      <template v-if="showDiff">
        <p v-if="diffError" class="error">{{ diffError }}</p>
        <p v-else-if="!baseBody" class="muted">差分を計算中…</p>
        <template v-else>
          <p class="muted">v{{ baseBody.version }} → v{{ data.version.version }} の差分(追加=緑 / 削除=赤)</p>
          <DiffView :old-text="oldText" :new-text="newText" />
        </template>
      </template>

      <EpisodeReader
        v-else
        :title="data.version.title"
        :preface-html="data.version.prefaceHtml ?? undefined"
        :body-html="data.version.bodyHtml"
        :afterword-html="data.version.afterwordHtml ?? undefined"
      >
        <template #header>
          <div class="crumbs">
            <RouterLink :to="tocRoute">&lt; {{ data.novel.title || data.novel.novelKey }}</RouterLink>
          </div>
        </template>
        <template #footer>
          <nav class="pager">
            <RouterLink v-if="data.episode.prevEpisodeId" class="pg" :to="epRoute(data.episode.prevEpisodeId)">&lt; 前の話</RouterLink>
            <span v-else class="pg off">&lt; 前の話</span>
            <RouterLink class="pg" :to="tocRoute">目次</RouterLink>
            <RouterLink v-if="data.episode.nextEpisodeId" class="pg" :to="epRoute(data.episode.nextEpisodeId)">次の話 &gt;</RouterLink>
            <span v-else class="pg off">次の話 &gt;</span>
          </nav>
        </template>
      </EpisodeReader>
    </template>
  </div>
</template>

<style scoped>
.vbar { display: flex; gap: 10px 14px; align-items: center; flex-wrap: wrap; padding: 10px 14px; }
.vbar label { display: flex; gap: 6px; align-items: center; font-size: 14px; }
.badge.del { background: var(--c-danger); color: #fff; }
.crumbs { font-size: 14px; min-width: 0; }
.crumbs a { color: inherit; }
.pager { display: flex; gap: 8px; justify-content: space-between; }
.pg { flex: 1; text-align: center; padding: 10px 8px; border: 1px solid currentColor; border-radius: 8px; text-decoration: none; color: inherit; font-size: 15px; }
.pg.off { opacity: 0.35; }
</style>
