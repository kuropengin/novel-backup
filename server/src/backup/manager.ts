/** バックアップメインのロジック */

import { Db, nowIso } from "../db/index.js";
import { NotificationRepository } from "../db/notification.repository.js";
import { BackupConfig, BackupTask, SiteId, TaskType, ScrapeResult, BackupProgressEvent } from "./types.js";
import { RateLimiter, ConcurrencyController } from "./rateLimit.js";
import { BackupRepository } from "./repository.js";
import { createScraper, BaseScraper } from "./scrapers.js";

type RunCounter = { processed: number; failed: number; total: number };

export class BackupManager {
  private repository: BackupRepository;
  private notificationRepository: NotificationRepository;
  private rateLimiter: RateLimiter;
  private concurrency: ConcurrencyController;
  private scrapers: Map<SiteId, BaseScraper> = new Map();
  private isRunning = false;
  private currentRunId: number | null = null;
  private runMode: "cycle" | "novel" | null = null;
  /** 作品単位の実行で処理する対象(実行中に追加されうる) */
  private novelTargets: Array<{ site: SiteId; novelKey: string }> = [];
  /** 作品単位の実行中に cron が発火した場合、終了後に全体サイクルを 1 回実行する */
  private cycleRequested = false;
  private progressListeners = new Set<(event: BackupProgressEvent) => void>();

  /** scrapers はテスト用の差し替え口(省略時は Python スクレイパー) */
  constructor(private db: Db, private config: BackupConfig, scrapers?: Map<SiteId, BaseScraper>) {
    this.repository = new BackupRepository(db);
    this.notificationRepository = new NotificationRepository(db);
    this.rateLimiter = new RateLimiter({ requestsPerSecond: config.rateLimit });
    this.concurrency = new ConcurrencyController(config.maxParallel);

    // スクレイパーを初期化
    for (const site of ["hameln", "narou", "kakuyomu"] as const) {
      this.scrapers.set(site, scrapers?.get(site) ?? createScraper(site, { pythonBin: config.pythonBin }));
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
   * 定期バックアップのメイン処理(全作品をエンキューして全タスクを処理)
   */
  async runBackupCycle(): Promise<void> {
    if (this.isRunning) {
      // 作品単位の実行中に cron が発火した場合は、終了後に 1 回だけ全体サイクルを実行する(取りこぼさない)
      if (this.runMode === "novel") {
        console.log("[Backup] Single-novel run in progress, deferring cycle until it finishes");
        this.cycleRequested = true;
      } else {
        console.log("[Backup] Already running, skipping cycle");
      }
      return;
    }
    await this.run("cycle");
  }

  /**
   * 作品単位の即時バックアップ。その作品のタスクだけを処理し、他作品の pending タスクには触れない
   * (enqueueTrackedNovels も呼ばない)。実行中の場合の挙動:
   * - 全体サイクル実行中: 優先度 100 でキューに入れるだけ(実行中のサイクルが拾う)
   * - 作品単位の実行中: 対象に追加し、実行中のループが続けて処理する
   * 戻り値は、この呼び出しで新たに実行を開始したか。
   */
  async runNovelBackup(site: SiteId, novelKey: string): Promise<boolean> {
    this.repository.enqueueTasks(site, [novelKey], "all", 100);
    if (this.isRunning) {
      if (this.runMode === "novel") this.novelTargets.push({ site, novelKey });
      return false;
    }
    this.novelTargets = [{ site, novelKey }];
    await this.run("novel");
    return true;
  }

  /** 実行中か(全体サイクル / 作品単位のどちらでも) */
  isBusy(): boolean {
    return this.isRunning;
  }

  private async run(mode: "cycle" | "novel"): Promise<void> {
    this.isRunning = true;
    this.runMode = mode;
    const runStats = this.repository.createRunStats();
    this.currentRunId = runStats.id;

    console.log(`[Backup] Starting ${mode === "cycle" ? "backup cycle" : "single-novel backup"} (run_id=${runStats.id})`);

    try {
      if (mode === "cycle") {
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
      }

      // 最初にタスク数をカウント(作品単位では対象作品の分だけ)
      const stats = this.repository.getTaskStats();
      const counter: RunCounter = {
        processed: 0,
        failed: 0,
        total: mode === "cycle" ? stats.pending + stats.inProgress : this.novelTargets.length,
      };
      this.repository.updateRunStatsTotals(runStats.id, counter.total);

      console.log(`[Backup] Found ${counter.total} tasks to process`);

      this.emitProgress({
        runId: runStats.id,
        phase: "metadata",
        message: `${counter.total}件のタスクを処理開始`,
        currentTasks: 0,
        totalTasks: counter.total,
        completedTasks: 0,
        failedTasks: 0,
      });

      // タスク処理ループ(作品単位では対象作品のタスクのみ。実行中に追加された対象も拾う)
      while (true) {
        const task = this.repository.getNextTask(mode === "novel" ? this.novelTargets : undefined);
        if (!task) break;
        // 実行中に追加された対象・リトライ分で総数を超えないようにする
        counter.total = Math.max(counter.total, counter.processed + counter.failed + 1);
        await this.processTask(runStats.id, task, counter);
      }

      console.log(`[Backup] ${mode === "cycle" ? "Cycle" : "Single-novel run"} completed: ${counter.processed} tasks`);
      this.repository.finishRunStats(runStats.id, "completed");
      this.emitProgress({
        runId: runStats.id,
        phase: "completed",
        message: `バックアップ完了: ${counter.processed}/${counter.total}`,
        currentTasks: counter.processed,
        totalTasks: counter.total,
        completedTasks: counter.processed,
        failedTasks: counter.failed,
      });

      // バックアップ完了時に管理者ユーザーに通知を送る
      try {
        const adminUsers = this.db.prepare(`SELECT id FROM users WHERE role = 'admin'`).all() as { id: number }[];
        for (const admin of adminUsers) {
          this.notificationRepository.createNotification(
            admin.id,
            "backup",
            "バックアップが完了しました",
            `${counter.processed}個のタスクが完了しました`
          );
        }
      } catch (e) {
        console.error("[Backup] Failed to send notification:", e);
      }
    } catch (error) {
      console.error("[Backup] Run failed:", error);
      this.repository.finishRunStats(runStats.id, "failed");
    } finally {
      // ループの空判定からここまで await を挟まないこと(実行中に追加された作品の取りこぼし防止)
      this.isRunning = false;
      this.runMode = null;
      this.currentRunId = null;
      this.novelTargets = [];
      if (this.cycleRequested) {
        this.cycleRequested = false;
        void this.runBackupCycle().catch((e) => console.error("[Backup] Deferred cycle failed:", e));
      }
    }
  }

  /** 1 タスクの処理(全体サイクルと作品単位の実行で共用)。失敗はログと実行統計のみで通知しない。 */
  private async processTask(runId: number, task: BackupTask, counter: RunCounter): Promise<void> {
    this.repository.startTask(task.id);

    try {
      this.emitProgress({
        runId,
        phase: "metadata",
        site: task.site,
        novelKey: task.novelKey,
        message: `${task.site}/${task.novelKey} を処理中`,
        currentTasks: counter.processed + 1,
        totalTasks: counter.total,
        completedTasks: counter.processed,
        failedTasks: counter.failed,
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
              runId,
              phase: "content",
              site: task.site,
              novelKey: task.novelKey,
              message: `本文取得 ${targets.length}話`,
              currentTasks: counter.processed + 1,
              totalTasks: counter.total,
              completedTasks: counter.processed,
              failedTasks: counter.failed,
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
      this.repository.incrementRunStatsCompleted(runId, result.episodes?.length || 0);
      counter.processed++;

      if (counter.processed % 10 === 0) {
        console.log(`[Backup] Progress: ${counter.processed}/${counter.total} tasks completed`);
      }
      this.emitProgress({
        runId,
        phase: "episodes",
        site: task.site,
        novelKey: task.novelKey,
        message: `完了 ${counter.processed}/${counter.total}`,
        currentTasks: counter.processed,
        totalTasks: counter.total,
        completedTasks: counter.processed,
        failedTasks: counter.failed,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[Backup] Task failed for ${task.site}/${task.novelKey}: ${errorMessage}`);
      this.repository.failTask(task.id, errorMessage, task.maxRetries);
      this.repository.incrementRunStatsFailed(runId, errorMessage);
      counter.failed++;
      this.emitProgress({
        runId,
        phase: "failed",
        site: task.site,
        novelKey: task.novelKey,
        message: `失敗: ${errorMessage}`,
        currentTasks: counter.processed + 1,
        totalTasks: counter.total,
        completedTasks: counter.processed,
        failedTasks: counter.failed,
      });
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
