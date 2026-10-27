<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { bookmarksApi, liveApi } from "../api";
import { errorMessage } from "../api/client";
import type { LiveEpisode, SiteId } from "../api/types";
import EpisodeReader from "../components/EpisodeReader.vue";

const route = useRoute();
const ep = ref<LiveEpisode | null>(null);
const error = ref("");
const loading = ref(false);

const site = computed(() => route.params.site as SiteId);
const novelKey = computed(() => route.params.novelKey as string);
const episodeKey = computed(() => route.params.episodeKey as string);

async function load() {
  loading.value = true;
  error.value = "";
  ep.value = null;
  try {
    const e = await liveApi.episode(site.value, novelKey.value, episodeKey.value);
    ep.value = e;
    await nextTick();
    window.scrollTo(0, 0);
    // ブックマーク済みなら最後に読んだ話を更新(失敗しても閲覧は継続)
    if (e.bookmarkId !== null) {
      bookmarksApi.update(e.bookmarkId, { lastReadEpisodeKey: e.episodeKey }).catch(() => undefined);
    }
  } catch (err) {
    error.value = errorMessage(err);
  } finally {
    loading.value = false;
  }
}
watch(() => [site.value, novelKey.value, episodeKey.value], load, { immediate: true });

const tocRoute = computed(() => ({ name: "live-novel", params: { site: site.value, novelKey: novelKey.value } }));
function epRoute(key: string) {
  return { name: "live-episode", params: { site: site.value, novelKey: novelKey.value, episodeKey: key } };
}
</script>

<template>
  <div class="ep-page">
    <p v-if="loading" class="muted">読み込み中…</p>
    <div v-if="error" class="card">
      <p class="error">{{ error }}</p>
      <button class="secondary small" @click="load">再試行</button>
      <RouterLink :to="tocRoute" style="margin-left: 8px">目次へ戻る</RouterLink>
    </div>
    <EpisodeReader
      v-if="ep"
      :title="ep.title"
      :preface-html="ep.prefaceHtml"
      :body-html="ep.bodyHtml"
      :afterword-html="ep.afterwordHtml"
    >
      <template #header>
        <div class="crumbs">
          <RouterLink :to="tocRoute">&lt; {{ ep.novelTitle }}</RouterLink>
          <span v-if="ep.index >= 0" class="muted"> ({{ ep.index + 1 }} / {{ ep.total }})</span>
        </div>
      </template>
      <template #footer>
        <nav class="pager">
          <RouterLink v-if="ep.prevEpisodeKey" class="pg" :to="epRoute(ep.prevEpisodeKey)">&lt; 前の話</RouterLink>
          <span v-else class="pg off">&lt; 前の話</span>
          <RouterLink class="pg" :to="tocRoute">目次</RouterLink>
          <RouterLink v-if="ep.nextEpisodeKey" class="pg" :to="epRoute(ep.nextEpisodeKey)">次の話 &gt;</RouterLink>
          <span v-else class="pg off">次の話 &gt;</span>
        </nav>
      </template>
    </EpisodeReader>
  </div>
</template>

<style scoped>
.crumbs { font-size: 14px; min-width: 0; }
.crumbs a { color: inherit; }
.pager { display: flex; gap: 8px; justify-content: space-between; }
.pg { flex: 1; text-align: center; padding: 10px 8px; border: 1px solid currentColor; border-radius: 8px; text-decoration: none; color: inherit; font-size: 15px; }
.pg.off { opacity: 0.35; }
</style>
