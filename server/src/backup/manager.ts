/** バックアップメインのロジック */

import { Db, nowIso } from "../db/index.js";
import { NotificationRepository } from "../db/notification.repository.js";
import { BackupConfig, SiteId, TaskType, ScrapeResult, BackupProgressEvent } from "./types.js";
import { RateLimiter, ConcurrencyController } from "./rateLimit.js";
import { BackupRepository } from "./repository.js";
import { createScraper, BaseScraper } from "./scrapers.js";

export class BackupManager {
  private repository: BackupRepository;
  private notificationRepository: NotificationRepository;
  private rateLimiter: RateLimiter;
  private concurrency: ConcurrencyController;
  private scrapers: Map<SiteId, BaseScraper> = new Map();
  private isRunning = false;
  private currentRunId: number | null = null;
  private progressListeners = new Set<(event: BackupProgressEvent) => void>();

  constructor(private db: Db, private config: BackupConfig) {
    this.repository = new BackupRepository(db);
    this.notificationRepository = new NotificationRepository(db);
    this.rateLimiter = new RateLimiter({ requestsPerSecond: config.rateLimit });
    this.concurrency = new ConcurrencyController(config.maxParallel);

    // スクレイパーを初期化
    for (const site of ["hameln", "narou", "kakuyomu"] as const) {
      this.scrapers.set(site, createScraper(site, { pythonBin: config.pythonBin }));
    }
  }

  /**
   * 作品IDからバックアップタスクをエンキュー
   */
  enqueueNovelBackup(site: SiteId, novelKeys: string[], priority: number = 0): void {
    this.repository.enqueueTasks(site, novelKeys, "all", priority);
  }

  /**
   * メタデータのみバックアップをエンキュー
   */
  enqueueMetadataBackup(site: SiteId, novelKeys: string[], priority: number = 0): void {
    this.repository.enqueueTasks(site, novelKeys, "metadata", priority);
  }

  /**
   * 定期バックアップのメイン処理
   */
  async runBackupCycle(): Promise<void> {
    if (this.isRunning) {
      console.log("[Backup] Already running, skipping cycle");
      return;
    }

    this.isRunning = true;
    const runStats = this.repository.createRunStats();
    this.currentRunId = runStats.id;

    console.log(`[Backup] Starting backup cycle (run_id=${runStats.id})`);

    try {
      let totalTasks = 0;
      let processedTasks = 0;
      let failedTasks = 0;

      this.enqueueTrackedNovels();
      this.emitProgress({
        runId: runStats.id,
        phase: "enqueue",
        message: "バックアップ対象をキューに追加しました",
        currentTasks: 0,
        totalTasks: 0,
        completedTasks: 0,
        failedTasks: 0,
      });

      // 最初にタスク数をカウント
      const stats = this.repository.getTaskStats();
      totalTasks = stats.pending + stats.inProgress;
      this.repository.updateRunStatsTotals(runStats.id, totalTasks);

      console.log(`[Backup] Found ${totalTasks} tasks to process`);

      this.emitProgress({
        runId: runStats.id,
        phase: "metadata",
        message: `${totalTasks}件のタスクを処理開始`,
        currentTasks: 0,
        totalTasks,
        completedTasks: 0,
        failedTasks: 0,
      });

      // タスク処理ループ
      while (true) {
        const task = this.repository.getNextTask();
        if (!task) break;

        this.repository.startTask(task.id);

        try {
          this.emitProgress({
            runId: runStats.id,
            phase: "metadata",
            site: task.site,
            novelKey: task.novelKey,
            message: `${task.site}/${task.novelKey} を処理中`,
            currentTasks: processedTasks + 1,
            totalTasks,
            completedTasks: processedTasks,
            failedTasks,
          });

          const result = await this.concurrency.run(async () => await this._processTask(task.site, task.novelKey, task.taskType));

          // 結果を保存
          if (result.metadata) {
            this.repository.saveNovelMetadata(task.site, task.novelKey, result.metadata);
          }

          if (result.episodes) {
            this.repository.saveEpisodes(task.site, task.novelKey, result.episodes);
            if (task.taskType !== "metadata" && this.config.backupScopes.includes("content")) {
              const scraper = this.scrapers.get(task.site);
              if (!scraper) throw new Error(`No scraper for site: ${task.site}`);
              const targets = this.repository.pickContentFetchTargets(
                task.site,
                task.novelKey,
                result.episodes,
                this.config.maxContentFetchPerNovel
              );
              let savedContentCount = 0;
              if (targets.length > 0) {
                this.emitProgress({
                  runId: runStats.id,
                  phase: "content",
                  site: task.site,
                  novelKey: task.novelKey,
                  message: `本文取得 ${targets.length}話`,
                  currentTasks: processedTasks + 1,
                  totalTasks,
                  completedTasks: processedTasks,
                  failedTasks,
                });
              }
              for (const episode of targets) {
                await this.waitForRequestWindow();
                const content = await scraper.scrapeEpisodeContent(task.novelKey, episode.episodeKey);
                const saved = this.repository.saveEpisodeContent(
                  task.site,
                  task.novelKey,
                  episode.episodeKey,
                  content,
                  episode.updatedAt
                );
                if (saved) savedContentCount++;
              }
              if (targets.length > 0) {
                console.log(`[Backup] Saved ${savedContentCount}/${targets.length} updated episodes for ${task.novelKey}`);
              }
            }
          }

          this.repository.completeTask(task.id);
          this.repository.incrementRunStatsCompleted(runStats.id, result.episodes?.length || 0);
          processedTasks++;

          if (processedTasks % 10 === 0) {
            console.log(`[Backup] Progress: ${processedTasks}/${totalTasks} tasks completed`);
          }
          this.emitProgress({
            runId: runStats.id,
            phase: "episodes",
            site: task.site,
            novelKey: task.novelKey,
            message: `完了 ${processedTasks}/${totalTasks}`,
            currentTasks: processedTasks,
            totalTasks,
            completedTasks: processedTasks,
            failedTasks,
          });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          console.error(`[Backup] Task failed for ${task.site}/${task.novelKey}: ${errorMessage}`);
          this.repository.failTask(task.id, errorMessage, task.maxRetries);
          this.repository.incrementRunStatsFailed(runStats.id, errorMessage);
          failedTasks++;
          this.emitProgress({
            runId: runStats.id,
            phase: "failed",
            site: task.site,
            novelKey: task.novelKey,
            message: `失敗: ${errorMessage}`,
            currentTasks: processedTasks + 1,
            totalTasks,
            completedTasks: processedTasks,
            failedTasks,
          });
        }
      }

      console.log(`[Backup] Cycle completed: ${processedTasks} tasks`);
      this.repository.finishRunStats(runStats.id, "completed");
      this.emitProgress({
        runId: runStats.id,
        phase: "completed",
        message: `バックアップ完了: ${processedTasks}/${totalTasks}`,
        currentTasks: processedTasks,
        totalTasks,
        completedTasks: processedTasks,
        failedTasks,
      });
      
      // バックアップ完了時に管理者ユーザーに通知を送る
      try {
        const adminUsers = this.db.prepare(`SELECT id FROM users WHERE role = 'admin'`).all() as { id: number }[];
        for (const admin of adminUsers) {
          this.notificationRepository.createNotification(
            admin.id,
            "backup",
            "バックアップが完了しました",
            `${processedTasks}個のタスクが完了しました`
          );
        }
      } catch (e) {
        console.error("[Backup] Failed to send notification:", e);
      }
    } catch (error) {
      console.error("[Backup] Cycle failed:", error);
      this.repository.finishRunStats(runStats.id, "failed");
    } finally {
      this.isRunning = false;
      this.currentRunId = null;
    }
  }

  private async _processTask(site: SiteId, novelKey: string, taskType: TaskType): Promise<ScrapeResult> {
    const scraper = this.scrapers.get(site);
    if (!scraper) throw new Error(`No scraper for site: ${site}`);

    const result: ScrapeResult = { errors: [] };

    try {
      // メタデータ取得
      if (taskType === "metadata" || taskType === "all") {
        await this.waitForRequestWindow();
        result.metadata = await scraper.scrapeMetadata(novelKey);
        console.log(`[Backup] Scraped metadata for ${site}/${novelKey}`);
      }

      // エピソード一覧取得
      if (taskType === "all") {
        await this.waitForRequestWindow();
        result.episodes = await scraper.scrapeEpisodeList(novelKey);
        console.log(`[Backup] Scraped ${result.episodes.length} episodes for ${site}/${novelKey}`);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      result.errors.push(msg);
      throw error;
    }

    return result;
  }

  private enqueueTrackedNovels(): void {
    const novels = this.repository.listTrackedNovels();
    if (novels.length === 0) return;
    const grouped = new Map<SiteId, string[]>();
    for (const novel of novels) {
      const keys = grouped.get(novel.site) ?? [];
      keys.push(novel.novelKey);
      grouped.set(novel.site, keys);
    }
    for (const [site, keys] of grouped.entries()) {
      this.repository.enqueueTasks(site, keys, "all", 0);
    }
    console.log(`[Backup] Enqueued ${novels.length} tracked novels from DB`);
  }

  private async waitForRequestWindow(): Promise<void> {
    await this.rateLimiter.waitForSlot();
    const min = Math.max(0.01, this.config.randomRateMin);
    const max = Math.max(min, this.config.randomRateMax);
    const randomRps = min + Math.random() * (max - min);
    const waitMs = Math.ceil(1000 / randomRps);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  /**
   * 現在のステータスを取得
   */
  getStatus(): {
    running: boolean;
    currentRunId: number | null;
    taskStats: { pending: number; inProgress: number; completed: number; failed: number };
  } {
    return {
      running: this.isRunning,
      currentRunId: this.currentRunId,
      taskStats: this.repository.getTaskStats(),
    };
  }

  onProgress(listener: (event: BackupProgressEvent) => void): () => void {
    this.progressListeners.add(listener);
    return () => this.progressListeners.delete(listener);
  }

  private emitProgress(event: Omit<BackupProgressEvent, "timestamp">): void {
    const payload: BackupProgressEvent = { ...event, timestamp: nowIso() };
    for (const listener of this.progressListeners) listener(payload);
  }
}
