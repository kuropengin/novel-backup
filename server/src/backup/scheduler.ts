import { nowIso, type Db } from "../db/index.js";
import { getSettings, onSettingsChanged, type Settings } from "../settings.js";
import type { SiteAdapter, SiteId } from "../sites/types.js";
import { backupNovel, type BackupNovelResult } from "./service.js";

import type { BackupTrigger } from "./queue.js";
export type { BackupTrigger };

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

/** setTimeout の上限(約 24.8 日)。超える場合は到達時に再評価する。 */
const MAX_TIMEOUT = 2 ** 31 - 1;

export const realTimers: Timers = {
  set: (fn, ms) => {
    const h = setTimeout(fn, Math.min(Math.max(ms, 0), MAX_TIMEOUT));
    h.unref(); // タイマーだけでプロセス/vitest を生かさない
    return h;
  },
  clear: (h) => clearTimeout(h as NodeJS.Timeout),
};

/**
 * 次回の定期実行時刻を計算する(純関数)。
 * - interval=0 → null(無効)
 * - startAt あり: ローカル時刻の「今日の startAt」を基準に interval 分刻みのスロット(例 03:00 + 360 → 3,9,15,21 時)のうち now より後で最初のもの。
 *   停止中に過ぎたスロットは補完実行しない。
 * - startAt なし: 前回の定期/全体実行の終了時刻 + interval(履歴が無ければ now + interval)。過ぎていれば now。
 */
export function computeNextRun(
  s: Pick<Settings, "backupIntervalMinutes" | "backupStartAt">,
  now: Date,
  lastFinishedAt: Date | null,
): Date | null {
  const interval = s.backupIntervalMinutes;
  if (!interval || interval <= 0) return null;
  const intervalMs = interval * 60_000;
  if (s.backupStartAt) {
    const [h, m] = s.backupStartAt.split(":").map(Number);
    const anchor = new Date(now);
    anchor.setHours(h!, m!, 0, 0);
    const k = Math.floor((now.getTime() - anchor.getTime()) / intervalMs) + 1;
    return new Date(anchor.getTime() + k * intervalMs);
  }
  const base = lastFinishedAt ?? now;
  return new Date(Math.max(base.getTime() + intervalMs, now.getTime()));
}

export interface SchedulerDeps {
  db: Db;
  getAdapter: (site: SiteId) => SiteAdapter;
  now?: () => Date;
  timers?: Timers;
  log?: (msg: string) => void;
}

interface NovelJob {
  novelId: number;
  trigger: BackupTrigger;
  force: boolean;
}

export interface BackupStatus {
  running: boolean;
  /** 全作品の一括実行(定期/手動)中か */
  runningAll: boolean;
  currentNovel: { id: number; title: string } | null;
  queueLength: number;
  nextRunAt: string | null;
}

export type RunAllResult = { started: true; runId: number } | { started: false; reason: "running" };

interface RunTotals {
  novelsChecked: number;
  episodesFetched: number;
  versionsAdded: number;
  errors: { novelId: number; message: string }[];
  failedNovels: number;
}

/**
 * バックアップのスケジューラ兼キュー。
 * - 全作品の一括実行(runAll)は同時に 1 つだけ(多重実行防止)。
 * - 作品単位キュー(enqueue)は一括実行とは独立の順次ワーカー。同一作品の重複投入は無視。
 * - 同一作品の処理はロックで直列化(一括実行とキューが衝突しても版が二重にならない)。
 * - ホスト単位の間隔制御は politeFetch 側。
 */
export class BackupScheduler {
  private readonly db: Db;
  private readonly getAdapter: (site: SiteId) => SiteAdapter;
  private readonly now: () => Date;
  private readonly timers: Timers;
  private readonly log: (msg: string) => void;

  private queue: NovelJob[] = [];
  private queuedIds = new Set<number>();
  private draining: Promise<void> | null = null;
  private allRun: Promise<void> | null = null;
  private current = new Map<number, string>();
  private locks = new Map<number, Promise<unknown>>();

  private timer: unknown = null;
  private started = false;
  private unsubscribe: (() => void) | null = null;
  private nextRun: Date | null = null;

  constructor(deps: SchedulerDeps) {
    this.db = deps.db;
    this.getAdapter = deps.getAdapter;
    this.now = deps.now ?? (() => new Date());
    this.timers = deps.timers ?? realTimers;
    this.log = deps.log ?? ((m) => console.log(m));
  }

  /** 定期実行を開始(設定変更の購読 + 次回予約)。 */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.unsubscribe = onSettingsChanged((_s, db) => {
      if (db === this.db) this.reschedule();
    });
    this.reschedule();
  }

  stop(): void {
    this.started = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.clearTimer();
    this.nextRun = null;
  }

  private clearTimer(): void {
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
  }

  private lastFinishedAt(): Date | null {
    const row = this.db
      .prepare("SELECT MAX(finished_at) AS t FROM backup_runs WHERE trigger IN ('schedule','manual') AND finished_at IS NOT NULL")
      .get() as unknown as { t: string | null };
    return row.t ? new Date(row.t) : null;
  }

  /** 設定または実行状態の変化に応じて次回実行を再計算・再予約する。 */
  reschedule(): void {
    this.clearTimer();
    this.nextRun = null;
    if (!this.started) return;
    // 一括実行中は予約しない(終了時に再計算する)
    if (this.allRun) return;
    const now = this.now();
    const next = computeNextRun(getSettings(this.db), now, this.lastFinishedAt());
    this.nextRun = next;
    if (!next) return;
    this.timer = this.timers.set(() => this.onTimer(), next.getTime() - now.getTime());
  }

  private onTimer(): void {
    this.timer = null;
    void this.fire();
  }

  /** タイマー発火時の処理(テストから直接呼べる)。まだ時刻前なら再予約のみ。 */
  async fire(): Promise<RunAllResult | { started: false; reason: "not_due" }> {
    if (this.nextRun && this.now().getTime() < this.nextRun.getTime()) {
      this.reschedule();
      return { started: false, reason: "not_due" };
    }
    const r = this.runAll({ trigger: "schedule" });
    if (!r.started) this.reschedule();
    return r;
  }

  get nextRunAt(): Date | null {
    return this.nextRun;
  }

  status(): BackupStatus {
    const cur = [...this.current.entries()][0];
    return {
      running: this.allRun !== null || this.draining !== null,
      runningAll: this.allRun !== null,
      currentNovel: cur ? { id: cur[0], title: cur[1] } : null,
      queueLength: this.queue.length,
      nextRunAt: this.nextRun ? this.nextRun.toISOString() : null,
    };
  }

  /** すべての実行(一括 + キュー)が終わるまで待つ。テスト用。 */
  async idle(): Promise<void> {
    for (;;) {
      const p = [this.allRun, this.draining].filter((x): x is Promise<void> => x !== null);
      if (p.length === 0) return;
      await Promise.all(p);
    }
  }

  isQueued(novelId: number): boolean {
    return this.queuedIds.has(novelId);
  }

  /** 作品単位の投入。同じ作品が待機中/実行中なら無視。 */
  enqueue(novelId: number, trigger: BackupTrigger = "novel", opts: { force?: boolean } = {}): "queued" | "duplicate" | "missing" {
    const exists = this.db.prepare("SELECT 1 AS x FROM novels WHERE id = ?").get(novelId);
    if (!exists) return "missing";
    if (this.queuedIds.has(novelId)) {
      if (opts.force) {
        const j = this.queue.find((q) => q.novelId === novelId);
        if (j) j.force = true;
      }
      return "duplicate";
    }
    this.queuedIds.add(novelId);
    this.queue.push({ novelId, trigger, force: !!opts.force });
    if (!this.draining) {
      this.draining = this.drain();
    }
    return "queued";
  }

  private async drain(): Promise<void> {
    // 呼び出し元(enqueue)が同期的に return できるよう、最初に 1 tick 譲る
    await Promise.resolve();
    try {
      while (this.queue.length > 0) {
        const job = this.queue.shift()!;
        try {
          await this.runNovelJob(job);
        } catch (e) {
          this.log(`[backup] job error novel=${job.novelId}: ${e instanceof Error ? e.message : e}`);
        } finally {
          this.queuedIds.delete(job.novelId);
        }
      }
    } finally {
      // 同期的にクリアし、直後の enqueue が新しいワーカーを起動できるようにする
      this.draining = null;
    }
  }

  private async runNovelJob(job: NovelJob): Promise<void> {
    const runId = this.createRun(job.trigger);
    const totals = this.emptyTotals();
    await this.processNovel(job.novelId, job.force, totals);
    this.finishRun(runId, totals);
  }

  /** 全作品の一括実行。実行中なら started:false。 */
  runAll(opts: { trigger?: "schedule" | "manual"; force?: boolean } = {}): RunAllResult {
    if (this.allRun) return { started: false, reason: "running" };
    const trigger = opts.trigger ?? "manual";
    const runId = this.createRun(trigger);
    // 定期実行の通算回数(今回を含む)。fullRecheckEveryRuns の N 回に 1 回は全話再取得
    let full = !!opts.force;
    if (trigger === "schedule" && !full) {
      const n = getSettings(this.db).fullRecheckEveryRuns;
      if (n > 0) {
        const c = (this.db.prepare("SELECT COUNT(*) AS c FROM backup_runs WHERE trigger = 'schedule'").get() as unknown as { c: number }).c;
        full = c % n === 0;
      }
    }
    this.clearTimer();
    this.nextRun = null;
    this.allRun = this.executeAll(runId, full)
      .catch((e) => this.log(`[backup] run error: ${e instanceof Error ? e.message : e}`))
      .finally(() => {
        this.allRun = null;
        this.reschedule();
      });
    return { started: true, runId };
  }

  private async executeAll(runId: number, force: boolean): Promise<void> {
    const ids = this.db
      .prepare(
        `SELECT DISTINCT n.id FROM bookmarks b JOIN novels n ON n.id = b.novel_id
         ORDER BY n.last_checked_at ASC, n.id ASC`,
      )
      .all() as unknown as { id: number }[];
    const totals = this.emptyTotals();
    for (const { id } of ids) {
      await this.processNovel(id, force, totals);
      this.updateRun(runId, totals);
    }
    this.finishRun(runId, totals);
  }

  private emptyTotals(): RunTotals {
    return { novelsChecked: 0, episodesFetched: 0, versionsAdded: 0, errors: [], failedNovels: 0 };
  }

  private async processNovel(novelId: number, force: boolean, totals: RunTotals): Promise<void> {
    const row = this.db.prepare("SELECT title, site, novel_key FROM novels WHERE id = ?").get(novelId) as unknown as
      | { title: string; site: string; novel_key: string }
      | undefined;
    if (!row) return;
    const prev = this.locks.get(novelId) ?? Promise.resolve();
    const task = prev.catch(() => undefined).then(async (): Promise<BackupNovelResult> => {
      this.current.set(novelId, row.title || `${row.site}/${row.novel_key}`);
      try {
        return await backupNovel(this.db, this.getAdapter, novelId, { force, log: this.log });
      } finally {
        this.current.delete(novelId);
      }
    });
    this.locks.set(novelId, task);
    let r: BackupNovelResult;
    try {
      r = await task;
    } catch (e) {
      r = {
        novelId,
        status: "failed",
        episodesFetched: 0,
        versionsAdded: 0,
        errors: [`予期しないエラー: ${e instanceof Error ? e.message : e}`],
        deletedOnSite: false,
      };
    } finally {
      if (this.locks.get(novelId) === task) this.locks.delete(novelId);
    }
    totals.novelsChecked++;
    totals.episodesFetched += r.episodesFetched;
    totals.versionsAdded += r.versionsAdded;
    if (r.status === "failed") totals.failedNovels++;
    for (const message of r.errors) totals.errors.push({ novelId, message });
  }

  private createRun(trigger: BackupTrigger): number {
    const r = this.db
      .prepare("INSERT INTO backup_runs (trigger, started_at, status) VALUES (?, ?, 'running')")
      .run(trigger, this.now().toISOString());
    return Number(r.lastInsertRowid);
  }

  private updateRun(runId: number, t: RunTotals): void {
    this.db
      .prepare("UPDATE backup_runs SET novels_checked = ?, episodes_fetched = ?, versions_added = ?, errors_json = ? WHERE id = ?")
      .run(t.novelsChecked, t.episodesFetched, t.versionsAdded, JSON.stringify(t.errors), runId);
  }

  private finishRun(runId: number, t: RunTotals): void {
    const status =
      t.errors.length === 0 ? "success" : t.novelsChecked > 0 && t.failedNovels === t.novelsChecked ? "failed" : "partial";
    this.updateRun(runId, t);
    this.db.prepare("UPDATE backup_runs SET status = ?, finished_at = ? WHERE id = ?").run(status, this.now().toISOString(), runId);
  }
}

/** 起動時: running のまま残った実行(前回の異常終了)を failed にする。 */
export function markStaleRunsFailed(db: Db): number {
  const r = db
    .prepare(
      `UPDATE backup_runs SET status = 'failed', finished_at = ?,
         errors_json = CASE WHEN errors_json = '[]' THEN '[{"novelId":0,"message":"サーバー停止により中断されました"}]' ELSE errors_json END
       WHERE status = 'running'`,
    )
    .run(nowIso());
  return Number(r.changes);
}
