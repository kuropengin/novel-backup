<script setup lang="ts">
import { onMounted, ref } from "vue";
import { backupsApi } from "../api";
import { errorMessage } from "../api/client";
import type { BackupRun } from "../api/types";
import { fmtDateTime } from "../composables/format";

const runs = ref<BackupRun[]>([]);
const error = ref("");
const loading = ref(true);
const open = ref<Set<number>>(new Set());

const TRIGGERS: Record<string, string> = { schedule: "定期", manual: "手動(全体)", bookmark: "ブックマーク追加", novel: "作品単位" };
const STATUSES: Record<string, string> = { running: "実行中", success: "成功", partial: "一部失敗", failed: "失敗" };

async function load() {
  loading.value = true;
  error.value = "";
  try {
    runs.value = (await backupsApi.runs()).runs;
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    loading.value = false;
  }
}
onMounted(load);

function toggle(id: number) {
  if (open.value.has(id)) open.value.delete(id);
  else open.value.add(id);
  open.value = new Set(open.value);
}
</script>

<template>
  <h2>実行履歴</h2>
  <p><button class="small secondary" :disabled="loading" @click="load">更新</button></p>
  <p v-if="error" class="error">{{ error }}</p>
  <p v-if="!loading && runs.length === 0" class="muted">実行履歴はまだありません。</p>
  <div v-if="runs.length" class="table-wrap">
    <table class="table">
      <thead>
        <tr>
          <th>開始</th>
          <th>種別</th>
          <th>状態</th>
          <th>作品</th>
          <th>取得話数</th>
          <th>追加版</th>
          <th>エラー</th>
        </tr>
      </thead>
      <tbody>
        <template v-for="r in runs" :key="r.id">
          <tr>
            <td>{{ fmtDateTime(r.startedAt) }}</td>
            <td>{{ TRIGGERS[r.trigger] ?? r.trigger }}</td>
            <td>
              <span class="badge" :class="{ admin: r.status === 'success', fail: r.status === 'failed' }">{{ STATUSES[r.status] ?? r.status }}</span>
            </td>
            <td>{{ r.novelsChecked }}</td>
            <td>{{ r.episodesFetched }}</td>
            <td>{{ r.versionsAdded }}</td>
            <td>
              <button v-if="r.errors.length" class="small secondary" @click="toggle(r.id)">{{ r.errors.length }} 件</button>
              <span v-else class="muted">-</span>
            </td>
          </tr>
          <tr v-if="open.has(r.id)">
            <td colspan="7">
              <ul class="errs">
                <li v-for="(e, i) in r.errors" :key="i"><span class="muted">作品 #{{ e.novelId }}:</span> {{ e.message }}</li>
              </ul>
              <p v-if="r.finishedAt" class="muted">終了: {{ fmtDateTime(r.finishedAt) }}</p>
            </td>
          </tr>
        </template>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.badge.fail { background: var(--c-danger); color: #fff; }
.errs { margin: 0; padding-left: 18px; font-size: 13px; }
</style>
