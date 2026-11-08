<script setup lang="ts">
import { computed } from "vue";
import Icon from "./Icon.vue";
import BottomSheet from "./BottomSheet.vue";
import type { Bookmark } from "../api";
import { formatDate, formatDateTime } from "../logic/lists";
import { siteColor, siteLabel } from "../logic/sites";

export interface BookmarkActionDialogProps {
  open: boolean;
  bookmark: (Bookmark & { offlineSaved?: boolean }) | null;
  /** 既読状況(read/total は話数、lastLabel は「第12話」など) */
  readInfo?: { read: number; total: number; lastLabel: string } | null;
  /** 自動バックアップの切り替え中 */
  togglingBackup?: boolean;
}

const props = withDefaults(defineProps<BookmarkActionDialogProps>(), { open: false, togglingBackup: false });
const emit = defineEmits<{
  (e: "close"): void;
  (e: "open-page"): void;
  (e: "open-reader"): void;
  (e: "resume"): void;
  (e: "download"): void;
  (e: "backup-now"): void;
  (e: "remove"): void;
  (e: "toggle-backup", enabled: boolean): void;
}>();

const b = computed(() => props.bookmark);
const canRead = computed(() => !!b.value?.lastBackupAllAt);
const downloadLabel = computed(() => (b.value?.offlineSaved ? "端末保存を更新する" : "端末に保存する"));
const backupEnabled = computed(() => b.value?.backupEnabled !== false);
const readText = computed(() => {
  const r = props.readInfo;
  if (!r || r.total <= 0) return "—";
  return `${r.read} / ${r.total}話`;
});

/** 操作したらシートを閉じる(切り替え系は閉じない) */
function act(e: "open-page" | "open-reader" | "resume" | "download" | "backup-now" | "remove") {
  if ((e === "open-reader" || e === "resume" || e === "download") && !canRead.value) return;
  if (e === "open-page") emit("open-page");
  else if (e === "open-reader") emit("open-reader");
  else if (e === "resume") emit("resume");
  else if (e === "download") emit("download");
  else if (e === "backup-now") emit("backup-now");
  else emit("remove");
  emit("close");
}
</script>

<template>
  <BottomSheet :open="props.open" label="作品詳細" height="70vh" @close="emit('close')">
    <div v-if="b" class="detail">
      <header class="head">
        <div class="title">
          <span class="site-badge" :style="{ background: siteColor(b.site) }">{{ siteLabel(b.site) }}</span>{{ b.title || b.novelKey }}
        </div>
        <div class="author">{{ b.author || "作者不明" }}</div>
      </header>

      <div class="body">
        <dl class="facts">
          <div><dt>更新日</dt><dd>{{ b.sourceUpdatedAt ? formatDateTime(b.sourceUpdatedAt) : "—" }}</dd></div>
          <div><dt>追加日</dt><dd>{{ formatDate(b.createdAt) }}</dd></div>
          <div><dt>最終バックアップ</dt><dd>{{ b.lastBackupAllAt ? formatDateTime(b.lastBackupAllAt) : "未バックアップ" }}</dd></div>
          <div><dt>バックアップ話数</dt><dd>{{ b.backupEpisodeCount ?? 0 }}話</dd></div>
          <div><dt>既読</dt><dd>{{ readText }}</dd></div>
          <div><dt>最終既読</dt><dd>{{ props.readInfo?.lastLabel || "—" }}</dd></div>
          <div><dt>端末保存</dt><dd>{{ b.offlineSaved ? "済み" : "未保存" }}</dd></div>
        </dl>

        <label class="switch-row" :class="{ busy: props.togglingBackup }">
          <span class="text">
            <span class="name">自動バックアップ</span>
            <span class="hint">{{ backupEnabled ? "定期バックアップで更新を取得します" : "定期バックアップの対象外です(公開停止・削除された作品など)" }}</span>
          </span>
          <input
            type="checkbox"
            role="switch"
            class="switch"
            :checked="backupEnabled"
            :disabled="props.togglingBackup"
            @change="emit('toggle-backup', ($event.target as HTMLInputElement).checked)"
          />
        </label>

        <div class="actions">
          <button class="action" @click="act('open-page')"><Icon name="link" :size="20" /><span>作品ページを開く</span></button>
          <button class="action" :disabled="!canRead" @click="act('download')">
            <Icon name="download" :size="20" /><span>{{ downloadLabel }}</span><span v-if="!canRead" class="note">未バックアップ</span>
          </button>
          <button class="action" @click="act('backup-now')"><Icon name="refresh" :size="20" /><span>今すぐバックアップ</span></button>
          <button class="action danger" @click="act('remove')"><Icon name="trash" :size="20" /><span>お気に入りから削除</span></button>
        </div>
      </div>

      <footer class="foot">
        <p v-if="!canRead" class="foot-note">バックアップ後にアプリで読めます</p>
        <button class="btn secondary" :disabled="!canRead" @click="act('open-reader')"><Icon name="book" :size="18" />エピソード一覧</button>
        <button class="btn accent" :disabled="!canRead" @click="act('resume')"><Icon name="book" :size="18" />続きから読む</button>
      </footer>
    </div>
  </BottomSheet>
</template>

<style scoped>
/* シート(70vh 固定)の中で、見出しと下部ボタンは固定し、中央だけスクロールする */
.detail { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.head { flex: none; padding: 2px 0 12px; border-bottom: 1px solid var(--border); }
.head .title { font-weight: 800; font-size: 17px; line-height: 1.4; word-break: break-all; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; }
.head .author { margin-top: 4px; font-size: 14px; color: var(--muted); }
.body { flex: 1; min-height: 0; overflow-y: auto; padding: 12px 0; -webkit-overflow-scrolling: touch; }

.facts { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 16px; margin: 0; padding: 12px 14px; border-radius: 14px; background: var(--surface); }
.facts div { min-width: 0; }
.facts dt { font-size: 11px; color: var(--muted); }
.facts dd { margin: 1px 0 0; font-size: 14px; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.switch-row { display: flex; align-items: center; gap: 12px; margin-top: 12px; padding: 12px 14px; border: 1px solid var(--border); border-radius: 14px; }
.switch-row.busy { opacity: 0.6; }
.switch-row .text { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.switch-row .name { font-weight: 700; font-size: 15px; }
.switch-row .hint { font-size: 12px; color: var(--muted); }
.switch { flex: none; appearance: none; -webkit-appearance: none; width: 46px; height: 28px; margin: 0; padding: 0; border: 0; border-radius: 999px; background: var(--border); position: relative; transition: background 0.15s; }
.switch::after { content: ""; position: absolute; top: 3px; left: 3px; width: 22px; height: 22px; border-radius: 50%; background: #fff; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3); transition: transform 0.15s; }
.switch:checked { background: var(--accent); }
.switch:checked::after { transform: translateX(18px); }

.actions { display: flex; flex-direction: column; margin-top: 12px; }
.action { display: flex; align-items: center; gap: 14px; width: 100%; padding: 13px 4px; border: 0; border-bottom: 1px solid var(--border); background: none; color: var(--fg); font-size: 15px; text-align: left; }
.action:last-child { border-bottom: 0; }
.action:active:not(:disabled) { background: var(--hover); }
.action:disabled { opacity: 0.45; }
.action.danger { color: var(--danger); }
.action .note { margin-left: auto; font-size: 12px; color: var(--muted); }

.foot { flex: none; display: grid; grid-template-columns: 1fr 1fr; gap: 10px; padding: 12px 0 calc(var(--sab) + 12px); border-top: 1px solid var(--border); }
.foot .btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
.foot .btn:disabled { opacity: 0.45; }
.foot-note { grid-column: 1 / -1; margin: 0; font-size: 12px; color: var(--muted); text-align: center; }
</style>
