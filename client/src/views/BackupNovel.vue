<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { backupsApi } from "../api";
import { errorMessage } from "../api/client";
import type { BackupEpisodeSummary, BackupNovelDetail } from "../api/types";
import { useBackupPoll } from "../composables/backupPoll";
import { fmtDate, fmtDateTime, SITE_NAMES } from "../composables/format";
import { useAuthStore } from "../stores/auth";

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const detail = ref<BackupNovelDetail | null>(null);
const error = ref("");
const info = ref("");
const loading = ref(false);
const showMeta = ref(false);
const novelId = computed(() => Number(route.params.novelId));

async function load(quiet = false) {
  if (!quiet) loading.value = true;
  error.value = "";
  try {
    detail.value = await backupsApi.novel(novelId.value);
  } catch (e) {
    error.value = errorMessage(e);
    detail.value = null;
  } finally {
    loading.value = false;
  }
}
watch(novelId, () => load(), { immediate: true });

const poll = useBackupPoll(async () => {
  info.value = "バックアップが完了しました。";
  await load(true);
});

async function runNow(force = false) {
  error.value = "";
  info.value = "";
  try {
    const r = await backupsApi.runNovel(novelId.value, force);
    info.value = r.alreadyQueued ? "すでに実行待ち/実行中です。" : "バックアップを開始しました…";
    poll.start();
  } catch (e) {
    error.value = errorMessage(e);
  }
}

async function remove() {
  const n = detail.value?.novel;
  if (!n || !confirm(`「${n.title}」のバックアップを全版ごと削除します。元に戻せません。よろしいですか?`)) return;
  try {
    await backupsApi.removeNovel(n.id);
    await router.push({ name: "backups" });
  } catch (e) {
    error.value = errorMessage(e);
  }
}

const groups = computed(() => {
  const out: { chapter: string; removed: boolean; items: BackupEpisodeSummary[] }[] = [];
  for (const e of detail.value?.episodes ?? []) {
    const removed = e.removedAt !== null;
    const ch = removed ? "" : (e.chapter ?? "");
    const last = out[out.length - 1];
    if (last && last.removed === removed && last.chapter === ch) last.items.push(e);
    else out.push({ chapter: ch, removed, items: [e] });
  }
  return out;
});

function metaChanges(i: number): string[] {
  const hist = detail.value?.metaVersions ?? [];
  const cur = hist[i]?.meta;
  const prev = hist[i + 1]?.meta;
  if (!cur) return [];
  if (!prev) return ["初回取得"];
  const out: string[] = [];
  if (cur.title !== prev.title) out.push(`タイトル: 「${prev.title}」→「${cur.title}」`);
  if (cur.author !== prev.author) out.push(`作者: 「${prev.author}」→「${cur.author}」`);
  if (cur.synopsis !== prev.synopsis) out.push("あらすじが変更");
  if (JSON.stringify(cur.tags) !== JSON.stringify(prev.tags)) out.push("タグが変更");
  if (cur.status !== prev.status) out.push(`状態: ${prev.status} → ${cur.status}`);
  const pt = hist[i + 1]!.tocCount;
  if (hist[i]!.tocCount !== pt) out.push(`話数: ${pt} → ${hist[i]!.tocCount}`);
  return out.length ? out : ["目次の更新日時等が変更"];
}
const statusLabel = computed(
  () => ({ ongoing: "連載中", completed: "完結" })[detail.value?.novel.siteStatus as "ongoing" | "completed"] ?? "",
);
</script>

<template>
  <div>
    <p><RouterLink to="/backups">&lt; バックアップ一覧</RouterLink></p>
    <p v-if="loading" class="muted">読み込み中…</p>
    <p v-if="error" class="error">{{ error }}</p>
    <template v-if="detail">
      <h2>{{ detail.novel.title || `(${detail.novel.novelKey})` }}</h2>
      <div class="card">
        <p class="muted">
          {{ detail.novel.author }}
          <span class="badge">{{ SITE_NAMES[detail.novel.site] ?? detail.novel.site }}</span>
          <span v-if="statusLabel" class="badge">{{ statusLabel }}</span>
          <span v-if="detail.novel.isDeletedOnSite" class="badge del">サイトで削除</span>
        </p>
        <p v-if="detail.meta?.tags?.length" class="tags">
          <span v-for="t in detail.meta.tags" :key="t" class="badge">{{ t }}</span>
        </p>
        <p v-if="detail.meta?.synopsis" class="synopsis">{{ detail.meta.synopsis }}</p>
        <p class="muted">
          最終チェック: {{ fmtDateTime(detail.novel.lastCheckedAt) }} / 最終変更: {{ fmtDateTime(detail.novel.lastChangedAt, "なし") }}
        </p>
        <p v-if="detail.novel.lastError" class="error">{{ detail.novel.lastError }}</p>
        <p v-if="info" class="ok">{{ info }}</p>
        <div class="row-actions">
          <button :disabled="poll.polling.value" @click="runNow(false)">
            {{ poll.polling.value ? "実行中…" : "今すぐバックアップ" }}
          </button>
          <button v-if="auth.isAdmin" class="secondary" :disabled="poll.polling.value" @click="runNow(true)">全話を再取得して比較</button>
          <a class="lnk" :href="backupsApi.exportUrl(detail.novel.id, 'txt')">テキストで保存</a>
          <a class="lnk" :href="backupsApi.exportUrl(detail.novel.id, 'html')">HTML で保存</a>
          <a class="lnk muted" :href="detail.novel.url" target="_blank" rel="noopener noreferrer">元サイト</a>
          <button v-if="auth.isAdmin" class="danger small" @click="remove">バックアップを削除</button>
        </div>
      </div>

      <h3>
        作品情報の履歴({{ detail.metaVersions.length }} 版)
        <button class="small secondary" @click="showMeta = !showMeta">{{ showMeta ? "閉じる" : "表示" }}</button>
      </h3>
      <div v-if="showMeta" class="card">
        <div v-for="(m, i) in detail.metaVersions" :key="m.version" class="mv">
          <strong>v{{ m.version }}</strong> <span class="muted">{{ fmtDateTime(m.fetchedAt) }}</span>
          <ul>
            <li v-for="c in metaChanges(i)" :key="c">{{ c }}</li>
          </ul>
          <details v-if="m.meta">
            <summary class="muted">この版のタイトル・あらすじ</summary>
            <p><strong>{{ m.meta.title }}</strong> / {{ m.meta.author }}</p>
            <p class="synopsis">{{ m.meta.synopsis }}</p>
          </details>
        </div>
      </div>

      <h3>
        目次({{ detail.novel.episodeCount }} 話<template v-if="detail.novel.removedCount"> + 削除済み {{ detail.novel.removedCount }} 話</template>)
      </h3>
      <p v-if="detail.novel.unfetchedCount" class="muted">
        本文が未取得の話が {{ detail.novel.unfetchedCount }} 話あります(次回以降の実行で取得されます)。
      </p>
      <div class="card toc">
        <template v-for="(g, gi) in groups" :key="gi">
          <div v-if="g.removed" class="chapter">サイトから削除された話</div>
          <div v-else-if="g.chapter" class="chapter">{{ g.chapter }}</div>
          <template v-for="e in g.items" :key="e.id">
            <RouterLink
              v-if="e.versionCount"
              class="toc-item"
              :to="{ name: 'backup-episode', params: { novelId: detail.novel.id, episodeId: e.id } }"
            >
              <span class="t">
                {{ e.title }}
                <span v-if="e.removedAt" class="badge del">削除済み</span>
                <span v-if="e.versionCount > 1" class="badge ver">{{ e.versionCount }} 版</span>
              </span>
              <span class="d muted">{{ fmtDate(e.siteUpdatedAt ?? e.publishedAt) }}</span>
            </RouterLink>
            <div v-else class="toc-item off">
              <span class="t">
                {{ e.title }}
                <span v-if="e.removedAt" class="badge del">削除済み</span>
                <span class="badge">未取得</span>
              </span>
              <span class="d muted">{{ fmtDate(e.siteUpdatedAt ?? e.publishedAt) }}</span>
            </div>
          </template>
        </template>
      </div>
    </template>
  </div>
</template>

<style scoped>
.synopsis { white-space: pre-wrap; margin: 8px 0; }
.tags { display: flex; flex-wrap: wrap; gap: 4px; margin: 6px 0; }
.lnk { font-size: 14px; }
.badge.del { background: var(--c-danger); color: #fff; }
.badge.ver { background: var(--c-primary); color: var(--c-primary-text); }
.mv { padding: 6px 0; border-bottom: 1px solid var(--c-border); }
.mv:last-child { border-bottom: none; }
.mv ul { margin: 4px 0; padding-left: 20px; font-size: 14px; }
.toc { padding: 4px 0; }
.chapter { font-weight: 600; padding: 10px 14px 4px; font-size: 14px; }
.toc-item { display: flex; justify-content: space-between; gap: 12px; padding: 8px 14px; text-decoration: none; color: var(--c-text); border-bottom: 1px solid var(--c-border); }
.toc-item:last-child { border-bottom: none; }
a.toc-item:hover { background: var(--c-bg); }
.toc-item.off { color: var(--c-muted); }
.toc-item .d { white-space: nowrap; }
h3 .small { margin-left: 8px; }
</style>
