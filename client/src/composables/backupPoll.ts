import { onBeforeUnmount, ref } from "vue";
import { backupsApi } from "../api";
import type { BackupStatus } from "../api/types";

/**
 * バックアップ状態のポーリング。start() 後、実行中でなくなるまで 2 秒おきに /api/backups/status を取得し、
 * 終了したら onDone を呼ぶ。画面離脱で自動停止。
 */
export function useBackupPoll(onDone: () => void | Promise<void>, intervalMs = 2000) {
  const status = ref<BackupStatus | null>(null);
  const polling = ref(false);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let tries = 0;

  async function tick() {
    if (stopped) return;
    try {
      status.value = await backupsApi.status();
    } catch {
      /* 一時的な失敗は無視して継続 */
    }
    tries++;
    // 開始直後(キュー投入と実行開始の間)を拾うため、最低 2 回は確認する
    if ((status.value && !status.value.running && tries >= 2) || tries > 300) {
      polling.value = false;
      await onDone();
      return;
    }
    timer = setTimeout(tick, intervalMs);
  }

  function start() {
    if (timer) clearTimeout(timer);
    stopped = false;
    tries = 0;
    polling.value = true;
    timer = setTimeout(tick, 800);
  }
  function stop() {
    stopped = true;
    polling.value = false;
    if (timer) clearTimeout(timer);
  }
  onBeforeUnmount(stop);
  return { status, polling, start, stop };
}
