<script setup lang="ts">
import { computed } from "vue";
import Icon from "./Icon.vue";
import BottomSheet from "./BottomSheet.vue";
import type { Bookmark } from "../api";
import { formatDate } from "../logic/lists";

export interface BookmarkActionDialogProps {
  open: boolean;
  bookmark: (Bookmark & { offlineSaved?: boolean }) | null;
  /** 既読状況(read/total は話数、lastLabel は「第12話」など) */
  readInfo?: { read: number; total: number; lastLabel: string } | null;
}

const props = withDefaults(defineProps<BookmarkActionDialogProps>(), { open: false });
const emit = defineEmits<{
  (e: "close"): void;
  (e: "open-page"): void;
  (e: "open-reader"): void;
  (e: "resume"): void;
  (e: "download"): void;
  (e: "backup-now"): void;
  (e: "remove"): void;
}>();

const canReader = computed(() => !!(props.bookmark?.lastBackupAllAt));
const canDownload = computed(() => !!(props.bookmark?.lastBackupAllAt));
const downloadLabel = computed(() => (props.bookmark?.offlineSaved ? "端末保存を更新する" : "端末に保存する"));

function handleOpen() {
  emit("open-page");
  emit("close");
}

function handleReader() {
  if (canReader.value) {
    emit("open-reader");
    emit("close");
  }
}

function handleResume() {
  if (canReader.value) {
    emit("resume");
    emit("close");
  }
}

function handleDownload() {
  if (canDownload.value) {
    emit("download");
    emit("close");
  }
}

function handleRemove() {
  emit("remove");
  emit("close");
}

function handleBackup() {
  emit("backup-now");
  emit("close");
}
</script>

<template>
  <BottomSheet :open="props.open" title="作品を開く" @close="emit('close')">
    <div v-if="props.bookmark" class="dialog-content">
      <div class="bookmark-header">
        <div class="title">{{ props.bookmark.title || props.bookmark.novelKey }}</div>
        <div class="author">{{ props.bookmark.author }}</div>
        <div class="backup-info">追加日: {{ formatDate(props.bookmark.createdAt) }}</div>
        <div class="backup-info">
          最終バックアップ日時: {{ props.bookmark.lastBackupAllAt ? formatDate(props.bookmark.lastBackupAllAt) : "未バックアップ" }}
        </div>
        <div class="backup-info">バックアップ話数: {{ props.bookmark.backupEpisodeCount ?? 0 }} 話</div>
        <div v-if="props.readInfo && props.readInfo.total > 0" class="backup-info">
          既読 {{ props.readInfo.read }} / {{ props.readInfo.total }}話<template v-if="props.readInfo.lastLabel">・最終既読: {{ props.readInfo.lastLabel }}</template>
        </div>
        <div class="backup-info">オフライン保存: {{ props.bookmark.offlineSaved ? "済み" : "未保存" }}</div>
      </div>

      <button class="action-btn" @click="handleOpen">
        <Icon name="link" :size="18" />
        <span>作品ページを開く</span>
      </button>

      <button v-if="canReader" class="action-btn" @click="handleResume">
        <Icon name="book" :size="18" />
        <span>続きから読む</span>
      </button>

      <button class="action-btn" :disabled="!canReader" @click="handleReader">
        <Icon name="book" :size="18" />
        <span>バックアップをアプリで読む(エピソード一覧)</span>
        <span v-if="!canReader" class="disabled-note">(未バックアップ)</span>
      </button>

      <button class="action-btn" :disabled="!canDownload" @click="handleDownload">
        <Icon name="download" :size="18" />
        <span>{{ downloadLabel }}</span>
        <span v-if="!canDownload" class="disabled-note">(未バックアップ)</span>
      </button>

      <button class="action-btn primary" @click="handleBackup">
        <Icon name="refresh" :size="18" />
        <span>今すぐバックアップを実行</span>
      </button>

      <button class="action-btn danger" @click="handleRemove">
        <Icon name="trash" :size="18" />
        <span>お気に入りから削除</span>
      </button>
    </div>
  </BottomSheet>
</template>

<style scoped>
.dialog-content {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding: 0.5rem 0;
}

.bookmark-header {
  padding: 0.5rem 1rem;
  border-bottom: 1px solid var(--border);
}

.bookmark-header .title {
  font-weight: 600;
  font-size: 0.95rem;
  color: var(--fg);
  margin-bottom: 0.25rem;
}

.bookmark-header .author {
  font-size: 0.85rem;
  color: var(--muted);
  margin-bottom: 0.5rem;
}

.backup-info {
  font-size: 0.75rem;
  color: var(--muted);
}

.action-btn {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.75rem 1rem;
  border: none;
  background: transparent;
  text-align: left;
  cursor: pointer;
  font-size: 0.95rem;
  color: var(--fg);
  transition: background 0.2s;
}

.action-btn:hover:not(:disabled) {
  background: var(--surface);
}

.action-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.action-btn.danger {
  color: var(--danger);
}

.action-btn.primary {
  background: #2196f3;
  color: white;
  border-radius: 0.5rem;
  margin: 0.5rem 0;
}

.action-btn.primary:hover:not(:disabled) {
  background: #1976d2;
}

.disabled-note {
  margin-left: auto;
  font-size: 0.75rem;
  color: var(--muted);
  font-style: italic;
}
</style>
