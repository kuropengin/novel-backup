<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { bookmarksApi, liveApi } from "../api";
import { errorMessage } from "../api/client";
import type { NovelInfo, SiteId, TocEntry } from "../api/types";

const route = useRoute();
const novel = ref<NovelInfo | null>(null);
const error = ref("");
const loading = ref(false);
const busy = ref(false);
const lastRead = ref<string | null>(null);

const site = computed(() => route.params.site as SiteId);
const novelKey = computed(() => route.params.novelKey as string);

async function load() {
  loading.value = true;
  error.value = "";
  novel.value = null;
  lastRead.value = null;
  try {
    const n = await liveApi.novel(site.value, novelKey.value);
    novel.value = n;
    if (n.bookmarkId !== null) {
      const list = (await bookmarksApi.list()).bookmarks;
      lastRead.value = list.find((b) => b.id === n.bookmarkId)?.lastReadEpisodeKey ?? null;
    }
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    loading.value = false;
  }
}
watch(() => [site.value, novelKey.value], load, { immediate: true });

const groups = computed(() => {
  const out: { chapter: string; items: TocEntry[] }[] = [];
  for (const e of novel.value?.episodes ?? []) {
    const ch = e.chapter ?? "";
    const last = out[out.length - 1];
    if (last && last.chapter === ch) last.items.push(e);
    else out.push({ chapter: ch, items: [e] });
  }
  return out;
});

const resumeKey = computed(() => {
  const eps = novel.value?.episodes ?? [];
  if (!lastRead.value) return null;
  const i = eps.findIndex((e) => e.episodeKey === lastRead.value);
  return i >= 0 ? eps[Math.min(i + 1, eps.length - 1)]!.episodeKey : null;
});

const statusLabel = computed(() => ({ ongoing: "連載中", completed: "完結", unknown: "" })[novel.value?.status ?? "unknown"]);

function fmt(iso?: string) {
  return iso ? new Date(iso).toLocaleDateString("ja-JP") : "";
}

async function toggleBookmark() {
  const n = novel.value;
  if (!n) return;
  busy.value = true;
  error.value = "";
  try {
    if (n.bookmarked && n.bookmarkId !== null) {
      await bookmarksApi.remove(n.bookmarkId);
      novel.value = { ...n, bookmarked: false, bookmarkId: null };
    } else {
      const r = await bookmarksApi.create(n.site, n.novelKey);
      novel.value = { ...n, bookmarked: true, bookmarkId: r.bookmark.id };
    }
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="novel-page">
    <p v-if="loading" class="muted">読み込み中…(長編は目次の取得に時間がかかります)</p>
    <div v-if="error" class="card">
      <p class="error">{{ error }}</p>
      <button class="secondary small" @click="load">再試行</button>
      <RouterLink to="/live" style="margin-left: 8px">ライブ閲覧へ戻る</RouterLink>
    </div>
    <template v-if="novel">
      <h2>{{ novel.title }}</h2>
      <div class="card">
        <p class="muted">
          {{ novel.author }}
          <span v-if="statusLabel" class="badge">{{ statusLabel }}</span>
          <span v-if="novel.isShortStory" class="badge">短編</span>
        </p>
        <p v-if="novel.tags.length" class="tags">
          <span v-for="t in novel.tags" :key="t" class="badge">{{ t }}</span>
        </p>
        <p class="synopsis">{{ novel.synopsis }}</p>
        <div class="row-actions">
          <button :class="{ secondary: novel.bookmarked }" :disabled="busy" @click="toggleBookmark">
            {{ novel.bookmarked ? "ブックマーク済み(解除)" : "ブックマークに追加" }}
          </button>
          <RouterLink
            v-if="resumeKey"
            class="btn"
            :to="{ name: 'live-episode', params: { site: novel.site, novelKey: novel.novelKey, episodeKey: resumeKey } }"
          >
            続きから読む
          </RouterLink>
          <a :href="novel.url" target="_blank" rel="noopener noreferrer" class="muted">元サイトで開く</a>
        </div>
      </div>

      <h3>目次({{ novel.episodes.length }} 話)</h3>
      <div class="card toc">
        <template v-for="(g, gi) in groups" :key="gi">
          <div v-if="g.chapter" class="chapter">{{ g.chapter }}</div>
          <RouterLink
            v-for="e in g.items"
            :key="e.episodeKey"
            class="toc-item"
            :class="{ read: e.episodeKey === lastRead }"
            :to="{ name: 'live-episode', params: { site: novel.site, novelKey: novel.novelKey, episodeKey: e.episodeKey } }"
          >
            <span class="t">{{ e.title }}</span>
            <span class="d muted">{{ fmt(e.updatedAt ?? e.publishedAt) }}</span>
          </RouterLink>
        </template>
      </div>
    </template>
  </div>
</template>

<style scoped>
.synopsis { white-space: pre-wrap; margin: 8px 0 12px; }
.tags { display: flex; flex-wrap: wrap; gap: 4px; margin: 6px 0; }
.btn { text-decoration: none; display: inline-block; padding: 8px 14px; border: 1px solid var(--c-primary); border-radius: 6px; background: var(--c-primary); color: var(--c-primary-text); }
.toc { padding: 4px 0; }
.chapter { font-weight: 600; padding: 10px 14px 4px; font-size: 14px; }
.toc-item { display: flex; justify-content: space-between; gap: 12px; padding: 8px 14px; text-decoration: none; color: var(--c-text); border-bottom: 1px solid var(--c-border); }
.toc-item:last-child { border-bottom: none; }
.toc-item:hover { background: var(--c-bg); }
.toc-item.read .t::after { content: " (最後に読んだ話)"; color: var(--c-muted); font-size: 12px; }
.toc-item .d { white-space: nowrap; }
</style>
