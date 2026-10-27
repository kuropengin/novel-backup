<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { RouterLink } from "vue-router";
import { backupsApi } from "../api";
import { errorMessage } from "../api/client";
import type { BackupNovel, BackupStatus } from "../api/types";
import { fmtDateTime, SITE_NAMES } from "../composables/format";
import { useAuthStore } from "../stores/auth";

const auth = useAuthStore();
const novels = ref<BackupNovel[]>([]);
const status = ref<BackupStatus | null>(null);
const loading = ref(true);
const error = ref("");

onMounted(async () => {
  try {
    const [n, s] = await Promise.all([backupsApi.novels(), backupsApi.status()]);
    novels.value = n.novels;
    status.value = s;
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    loading.value = false;
  }
});

/** 最近変更(新版が追加)された作品 */
const recent = computed(() =>
  novels.value
    .filter((n) => n.lastChangedAt)
    .sort((a, b) => (b.lastChangedAt ?? "").localeCompare(a.lastChangedAt ?? ""))
    .slice(0, 8),
);
const errors = computed(() => novels.value.filter((n) => n.lastError));
const pending = computed(() => novels.value.filter((n) => !n.lastCheckedAt));
const lastCheck = computed(() => novels.value.map((n) => n.lastCheckedAt ?? "").sort().pop() || null);
</script>

<template>
  <h2>ホーム</h2>
  <p v-if="error" class="error">{{ error }}</p>
  <p v-if="loading" class="muted">読み込み中…</p>

  <div class="card">
    <h3 style="margin-top: 0">バックアップの状態</h3>
    <p>
      <span class="badge" :class="{ admin: status?.running }">{{ status?.running ? "実行中" : "待機中" }}</span>
      <span class="muted"> {{ novels.length }} 作品 / 最終チェック: {{ fmtDateTime(lastCheck, "なし") }}</span>
    </p>
    <p class="muted">
      <template v-if="status?.nextRunAt">次回の定期実行: {{ fmtDateTime(status.nextRunAt) }}</template>
      <template v-else-if="status && !status.running">定期実行は無効です</template>
      <template v-if="pending.length"> / 初回バックアップ待ち {{ pending.length }} 件</template>
    </p>
    <p v-if="auth.isAdmin"><RouterLink to="/admin/settings">バックアップ設定</RouterLink> / <RouterLink to="/admin/runs">実行履歴</RouterLink></p>
  </div>

  <div class="card">
    <h3 style="margin-top: 0">最近更新された作品</h3>
    <p v-if="!loading && recent.length === 0" class="muted">
      まだ更新はありません。<RouterLink to="/live">ライブ閲覧</RouterLink> で作品をブックマークするとバックアップされます。
    </p>
    <RouterLink v-for="n in recent" :key="n.id" class="row" :to="{ name: 'backup-novel', params: { novelId: n.id } }">
      <span class="t">{{ n.title || n.novelKey }} <span class="badge">{{ SITE_NAMES[n.site] ?? n.site }}</span></span>
      <span class="muted">{{ fmtDateTime(n.lastChangedAt) }}</span>
    </RouterLink>
  </div>

  <div v-if="errors.length" class="card">
    <h3 style="margin-top: 0">エラーのある作品</h3>
    <RouterLink v-for="n in errors" :key="n.id" class="row err" :to="{ name: 'backup-novel', params: { novelId: n.id } }">
      <span class="t">{{ n.title || n.novelKey }}</span>
      <span class="error">{{ n.lastError }}</span>
    </RouterLink>
  </div>
</template>

<style scoped>
.row { display: flex; justify-content: space-between; gap: 12px; padding: 8px 0; border-bottom: 1px solid var(--c-border); text-decoration: none; color: var(--c-text); flex-wrap: wrap; }
.row:last-child { border-bottom: none; }
.row.err { flex-direction: column; gap: 2px; }
.row .error { margin: 0; font-size: 13px; }
</style>
