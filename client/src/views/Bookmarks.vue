<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { RouterLink } from "vue-router";
import { backupsApi, bookmarksApi } from "../api";
import { errorMessage } from "../api/client";
import type { Bookmark } from "../api/types";
import { useBackupPoll } from "../composables/backupPoll";

const items = ref<Bookmark[]>([]);
const loading = ref(true);
const error = ref("");
const editing = ref<number | null>(null);
const draft = ref("");
const editingTitle = ref<number | null>(null);
const titleDraft = ref("");

const SITE_NAMES: Record<string, string> = { hameln: "ハーメルン", narou: "小説家になろう", kakuyomu: "カクヨム" };

async function load() {
  loading.value = true;
  error.value = "";
  try {
    items.value = (await bookmarksApi.list()).bookmarks;
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    loading.value = false;
  }
}
onMounted(load);

const running = ref<Set<number>>(new Set());
const poll = useBackupPoll(async () => {
  running.value = new Set();
  await load();
});
async function backupNow(b: Bookmark) {
  error.value = "";
  try {
    await backupsApi.runNovel(b.novelId);
    running.value = new Set(running.value).add(b.novelId);
    poll.start();
  } catch (e) {
    error.value = errorMessage(e);
  }
}

function startEdit(b: Bookmark) {
  editing.value = b.id;
  draft.value = b.note;
}
async function saveNote(b: Bookmark) {
  try {
    const r = await bookmarksApi.update(b.id, { note: draft.value });
    Object.assign(b, r.bookmark);
    editing.value = null;
  } catch (e) {
    error.value = errorMessage(e);
  }
}
function startEditTitle(b: Bookmark) {
  editingTitle.value = b.id;
  titleDraft.value = b.title;
}
async function saveTitle(b: Bookmark) {
  const title = titleDraft.value.trim();
  if (!title) return;
  try {
    const r = await bookmarksApi.update(b.id, { title });
    Object.assign(b, r.bookmark);
    editingTitle.value = null;
  } catch (e) {
    error.value = errorMessage(e);
  }
}
async function remove(b: Bookmark) {
  if (!confirm(`「${b.title || b.novelKey}」のブックマークを削除しますか?(バックアップ済みのデータは残ります)`)) return;
  try {
    await bookmarksApi.remove(b.id);
    items.value = items.value.filter((x) => x.id !== b.id);
  } catch (e) {
    error.value = errorMessage(e);
  }
}
function fmt(iso: string | null) {
  return iso ? new Date(iso).toLocaleString("ja-JP") : "未取得";
}
const empty = computed(() => !loading.value && items.value.length === 0 && !error.value);
</script>

<template>
  <h2>ブックマーク</h2>
  <p v-if="loading" class="muted">読み込み中…</p>
  <p v-if="error" class="error">{{ error }}</p>
  <div v-if="empty" class="card">
    <p>ブックマークはまだありません。</p>
    <p class="muted"><RouterLink to="/live">ライブ閲覧</RouterLink> で作品ページを開き「ブックマークに追加」を押してください。</p>
  </div>

  <div v-for="b in items" :key="b.id" class="card bm">
    <div v-if="editingTitle === b.id" class="note-edit">
      <input v-model="titleDraft" maxlength="500" placeholder="作品タイトル" @keyup.enter="saveTitle(b)" />
      <div class="row-actions">
        <button class="small" :disabled="!titleDraft.trim()" @click="saveTitle(b)">保存</button>
        <button class="small secondary" @click="editingTitle = null">キャンセル</button>
      </div>
    </div>
    <div v-else class="head">
      <RouterLink class="title" :to="{ name: 'live-novel', params: { site: b.site, novelKey: b.novelKey } }">
        {{ b.title || `(${b.novelKey})` }}
      </RouterLink>
      <span class="badge">{{ SITE_NAMES[b.site] ?? b.site }}</span>
      <span v-if="b.isDeletedOnSite" class="badge del">サイトで削除</span>
    </div>
    <p class="muted">
      {{ b.author }}
      <template v-if="b.lastBackupAt"> / 最終バックアップ: {{ fmt(b.lastBackupAt) }}</template>
      <template v-else> / バックアップ未取得</template>
      <template v-if="b.episodeCount"> / {{ b.episodeCount }} 話</template>
      <template v-if="b.unreadCount"> / 未読 {{ b.unreadCount }} 話</template>
    </p>
    <p v-if="b.lastError" class="error">{{ b.lastError }}</p>

    <div v-if="editing === b.id" class="note-edit">
      <textarea v-model="draft" rows="3" maxlength="2000" placeholder="メモ" />
      <div class="row-actions">
        <button class="small" @click="saveNote(b)">保存</button>
        <button class="small secondary" @click="editing = null">キャンセル</button>
      </div>
    </div>
    <p v-else-if="b.note" class="note">{{ b.note }}</p>

    <div class="row-actions">
      <RouterLink class="lnk" :to="{ name: 'live-novel', params: { site: b.site, novelKey: b.novelKey } }">ライブで開く</RouterLink>
      <RouterLink v-if="b.lastBackupAt" class="lnk" :to="{ name: 'backup-novel', params: { novelId: b.novelId } }">バックアップで開く</RouterLink>
      <RouterLink
        v-if="b.lastReadEpisodeKey"
        class="lnk"
        :to="{ name: 'live-episode', params: { site: b.site, novelKey: b.novelKey, episodeKey: b.lastReadEpisodeKey } }"
      >
        最後に読んだ話
      </RouterLink>
      <button class="small" :disabled="running.has(b.novelId)" @click="backupNow(b)">
        {{ running.has(b.novelId) ? "バックアップ中…" : "今すぐバックアップ" }}
      </button>
      <button class="small secondary" @click="startEditTitle(b)">タイトル編集</button>
      <button class="small secondary" @click="startEdit(b)">メモ編集</button>
      <button class="small danger" @click="remove(b)">削除</button>
    </div>
  </div>
</template>

<style scoped>
.head { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.title { font-weight: 600; font-size: 16px; }
.badge.del { background: var(--c-danger); color: #fff; }
.note { white-space: pre-wrap; background: var(--c-bg); border-radius: 6px; padding: 6px 10px; margin: 6px 0; font-size: 14px; }
.note-edit { margin: 8px 0; display: flex; flex-direction: column; gap: 6px; }
.note-edit input, .note-edit textarea { font: inherit; padding: 8px; border: 1px solid var(--c-border); border-radius: 6px; background: var(--c-surface); color: var(--c-text); width: 100%; }
.lnk { font-size: 14px; }
.row-actions { margin-top: 6px; }
</style>
