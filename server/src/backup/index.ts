/** バックアップシステムのパブリックAPI */

export { BackupScheduler } from "./scheduler.js";
export type { ScheduleConfig, ScheduleFrequency } from "./scheduler.js";
export { BackupManager } from "./manager.js";
export { BackupRepository } from "./repository.js";
export { RateLimiter, ConcurrencyController, PriorityQueue } from "./rateLimit.js";
export { createScraper, BaseScraper } from "./scrapers.js";
export type {
  SiteId,
  TaskType,
  BackupStatus,
  NovelMetadata,
  Episode,
  EpisodeContent,
  BackupTask,
  BackupRunStats,
  BackupConfig,
  ScrapeResult,
} from "./types.js";

import { Db } from "../db/index.js";
import { BackupScheduler } from "./scheduler.js";
import { BackupRepository as RecoveryRepository } from "./repository.js";
import type { ScheduleConfig } from "./scheduler.js";

/**
 * グローバルインスタンス（アプリ起動時に初期化）
 */
let globalScheduler: BackupScheduler | null = null;

/**
 * バックアップシステムを初期化
 */
export function initBackupSystem(db: Db, config: ScheduleConfig): BackupScheduler {
  if (globalScheduler) {
    console.warn("[Backup] Already initialized");
    return globalScheduler;
  }

  // スケジューラ/マネージャ起動前に、中断・失敗したタスクを巻き戻す
  try {
    const r = new RecoveryRepository(db).recoverInterruptedState();
    console.log(
      `[Backup] Startup recovery: in_progress tasks reset=${r.tasksReset}, failed tasks reset=${r.failedReset}, stale runs closed=${r.runsClosed}`
    );
  } catch (e) {
    console.error("[Backup] Startup recovery failed:", e);
  }

  globalScheduler = new BackupScheduler(db, config);
  globalScheduler.start();
  return globalScheduler;
}

/**
 * グローバルインスタンスを取得
 */
export function getBackupScheduler(): BackupScheduler {
  if (!globalScheduler) throw new Error("Backup system not initialized");
  return globalScheduler;
}

/**
 * グローバルインスタンスをシャットダウン
 */
export function shutdownBackupSystem(): void {
  if (globalScheduler) {
    globalScheduler.stop();
    globalScheduler = null;
  }
}

// プリセット
export { presets } from "./scheduler.js";
