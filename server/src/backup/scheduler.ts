/** 定期バックアップスケジューラー */

import cron, { type ScheduledTask } from "node-cron";
import { Db } from "../db/index.js";
import { BackupManager } from "./manager.js";
import { BackupConfig, SiteId, BackupProgressEvent } from "./types.js";

export type ScheduleFrequency = "hourly" | "daily" | "weekly";

export interface ScheduleConfig extends BackupConfig {
  frequency: ScheduleFrequency;
  timezone?: string;
  time?: string; // HH:mm 形式（日次・週次の場合）
}

export class BackupScheduler {
  private readonly db: Db;
  private manager: BackupManager;
  private cronJob: ScheduledTask | null = null;
  private config: ScheduleConfig;

  /** manager はテスト用の差し替え口 */
  constructor(db: Db, config: ScheduleConfig, manager?: BackupManager) {
    this.db = db;
    this.config = config;
    this.manager = manager ?? new BackupManager(db, config);
  }

  /**
   * スケジューラーを開始
   */
  start(): void {
    if (this.cronJob) {
      console.log("[Scheduler] Already running");
      return;
    }

    const cronExpression = this._getCronExpression();
    console.log(`[Scheduler] Starting backup scheduler: ${this.config.frequency} (${cronExpression})`);

    this.cronJob = cron.schedule(
      cronExpression,
      async () => {
        console.log("[Scheduler] Backup cycle triggered");
        try {
          await this.manager.runBackupCycle();
        } catch (error) {
          console.error("[Scheduler] Backup cycle failed:", error);
        }
      },
      {
        ...(this.config.timezone ? { timezone: this.config.timezone } : {}),
        // コンテナの一時停止/復帰などで大量の missed execution 警告が出るのを抑える
        suppressMissedWarning: true,
      }
    );
  }

  /**
   * スケジューラーを停止
   */
  stop(): void {
    if (this.cronJob) {
      this.cronJob.stop();
      this.cronJob = null;
      console.log("[Scheduler] Stopped");
    }
  }

  /**
   * 手動でバックアップサイクルをトリガー
   */
  async trigger(): Promise<void> {
    await this.manager.runBackupCycle();
  }

  /**
   * 作品 1 件だけを即時バックアップ(他作品のタスクは処理しない)。
   * 実行中ならキュー追加のみで合流し、新たに開始した場合のみ true。バックグラウンドで実行する。
   */
  triggerNovel(site: SiteId, novelKey: string): boolean {
    const started = !this.manager.isBusy();
    this.manager.runNovelBackup(site, novelKey).catch((e) => console.error("[Scheduler] Single-novel backup failed:", e));
    return started;
  }

  /**
   * 作品をバックアップキューに追加
   */
  enqueueNovel(site: SiteId, novelKeys: string[], priority?: number): void {
    this.manager.enqueueNovelBackup(site, novelKeys, priority);
  }

  /**
   * メタデータのみをバックアップキューに追加
   */
  enqueueMetadata(site: SiteId, novelKeys: string[], priority?: number): void {
    this.manager.enqueueMetadataBackup(site, novelKeys, priority);
  }

  /**
   * 現在のステータスを取得
   */
  getStatus(): {
    running: boolean;
    frequency: ScheduleFrequency;
    time?: string;
    maxParallel: number;
    currentRunId: number | null;
    taskStats: { pending: number; inProgress: number; completed: number; failed: number };
  } {
    const managerStatus = this.manager.getStatus();
    return {
      running: managerStatus.running,
      frequency: this.config.frequency,
      time: this.config.time,
      maxParallel: this.config.maxParallel,
      currentRunId: managerStatus.currentRunId,
      taskStats: managerStatus.taskStats,
    };
  }

  getConfig(): Pick<ScheduleConfig, "frequency" | "time" | "maxParallel"> {
    return { frequency: this.config.frequency, time: this.config.time, maxParallel: this.config.maxParallel };
  }

  updateConfig(next: Pick<ScheduleConfig, "frequency" | "time" | "maxParallel">): void {
    this.config = { ...this.config, ...next };
    this.stop();
    this.manager = new BackupManager(this.db, this.config);
    this.start();
  }

  onProgress(listener: (event: BackupProgressEvent) => void): () => void {
    return this.manager.onProgress(listener);
  }

  private _getCronExpression(): string {
    // 時刻指定がある場合
    const timespec = this.config.time || "00:00";
    const [hour, minute] = timespec.split(":").map(Number);

    switch (this.config.frequency) {
      case "hourly":
        // 毎時間 0 分に実行
        return "0 * * * *";
      case "daily":
        // 指定時刻に毎日実行（デフォルト 00:00）
        return `${minute} ${hour} * * *`;
      case "weekly":
        // 指定時刻に毎週月曜日に実行
        return `${minute} ${hour} * * 1`;
    }
  }
}

/**
 * 推奨設定プリセット
 */
export const presets = {
  /** 軽量バックアップ：メタデータのみ、週1回 */
  light: {
    frequency: "weekly" as const,
    maxParallel: 1,
    rateLimit: 0.3,
    randomRateMin: 0.2,
    randomRateMax: 0.3,
    maxRetries: 3,
    backupScopes: ["metadata"] as const,
    pythonBin: "python",
    maxContentFetchPerNovel: 0,
    checkInterval: 30000,
    time: "02:00",
  },

  /** 標準バックアップ：全データ、日1回 */
  standard: {
    frequency: "daily" as const,
    maxParallel: 5,
    rateLimit: 0.5,
    randomRateMin: 0.2,
    randomRateMax: 0.5,
    maxRetries: 3,
    backupScopes: ["metadata", "content"] as const,
    pythonBin: "python",
    maxContentFetchPerNovel: 50,
    checkInterval: 60000,
    time: "03:00",
  },

  /** 積極バックアップ：全データ、1時間毎 */
  hourlySafe: {
    frequency: "hourly" as const,
    maxParallel: 5,
    rateLimit: 0.5,
    randomRateMin: 0.2,
    randomRateMax: 0.5,
    maxRetries: 3,
    backupScopes: ["metadata", "content"] as const,
    pythonBin: "python",
    maxContentFetchPerNovel: 50,
    checkInterval: 120000,
  },
};
