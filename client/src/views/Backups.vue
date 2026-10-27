<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { RouterLink } from "vue-router";
import { backupsApi } from "../api";
import { errorMessage } from "../api/client";
import type { BackupNovel } from "../api/types";
import { fmtDateTime, SITE_NAMES } from "../composables/format";

const novels = ref<BackupNovel[]>([]);
const loading = ref(true);
const error = ref("");
const q = ref("");
const site = ref("");

onMounted(async () => {
  try {
    novels.value = (await backupsApi.novels()).novels;
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    loading.value = false;
  }
});

const filtered = computed(() => {
  const k = q.value.trim().toLowerCase();
  return novels.value.filter(
    (n) => (!site.value || n.site === site.value) && (!k || `${n.title} ${n.author} ${n.novelKey}`.toLowerCase().includes(k)),
  );
});
</script>

<template>
  <h2>バックアップ</h2>
  <div class="inline-form filters">
    <input v-model="q" type="search" placeholder="タイトル・作者で検索" />
    <select v-model="site">
      <option value="">すべてのサイト</option>
      <option v-for="(name, id) in SITE_NAMES" :key="id" :value="id">{{ name }}</option>
    </select>
  </div>
  <p v-if="loading" class="muted">読み込み中…</p>
  <p v-if="error" class="error">{{ error }}</p>
  <div v-if="!loading && !error && novels.length === 0" class="card">
    <p>バックアップ済みの作品はありません。</p>
    <p class="muted"><RouterLink to="/live">ライブ閲覧</RouterLink> で作品をブックマークすると自動でバックアップされます。</p>
  </div>
  <p v-else-if="!loading && filtered.length === 0 && !error" class="muted">条件に一致する作品がありません。</p>

  <RouterLink v-for="n in filtered" :key="n.id" class="card item" :to="{ name: 'backup-novel', params: { novelId: n.id } }">
    <div class="head">
      <span class="title">{{ n.title || `(${n.novelKey})` }}</span>
      <span class="badge">{{ SITE_NAMES[n.site] ?? n.site }}</span>
      <span v-if="n.isDeletedOnSite" class="badge del">サイトで削除</span>
      <span v-if="!n.bookmarked" class="badge">ブックマークなし</span>
      <span v-if="n.queued" class="badge">実行待ち</span>
    </div>
    <p class="muted">
      {{ n.author }} / {{ n.episodeCount }} 話<template v-if="n.removedCount"> + 削除済み {{ n.removedCount }} 話</template> / 版 {{ n.versionCount }}
      <template v-if="n.unfetchedCount"> / 未取得 {{ n.unfetchedCount }} 話</template>
    </p>
    <p class="muted">最終チェック: {{ fmtDateTime(n.lastCheckedAt) }} / 最終変更: {{ fmtDateTime(n.lastChangedAt, "なし") }}</p>
    <p v-if="n.lastError" class="error">{{ n.lastError }}</p>
  </RouterLink>
</template>

<style scoped>
.filters { margin-bottom: 12px; }
.filters input { flex: 1; min-width: 180px; }
.item { display: block; text-decoration: none; color: var(--c-text); }
.item:hover { border-color: var(--c-primary); }
.head { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.title { font-weight: 600; font-size: 16px; }
.badge.del { background: var(--c-danger); color: #fff; }
.item p { margin: 2px 0; }
</style>
