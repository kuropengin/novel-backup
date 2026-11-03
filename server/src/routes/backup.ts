/** バックアップ管理APIルート */

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { getBackupScheduler } from "../backup/index.js";
import type { BackupScheduler } from "../backup/scheduler.js";
import { readBackupScheduleSettings, writeBackupScheduleSettings } from "../backup/settings.js";
import { BackupRepository } from "../backup/repository.js";
import { requireAdmin, requireAuth, resolveSession } from "../auth/session.js";
import type { Db } from "../db/index.js";
import { nowIso } from "../db/index.js";
import { RateLimiter } from "../http/rateLimit.js";
import { isSiteId, normalizeNovelKey, SITE_IDS, type SiteId } from "../sites.js";

const siteSchema = z.enum(SITE_IDS as [SiteId, ...SiteId[]]);

const settingsSchema = z.object({
  frequency: z.enum(["hourly", "daily", "weekly"]),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  maxParallel: z.number().int().min(1).max(10),
});

/** 作品キーをサイト別に厳密検証して正規化(narou は小文字化)する zod スキーマ */
const enqueueSchema = z
  .object({
    site: siteSchema,
    novelKeys: z.array(z.string().max(64)).min(1).max(200),
    priority: z.number().int().min(0).max(100).optional(),
  })
  .transform((v, ctx) => {
    const keys: string[] = [];
    v.novelKeys.forEach((k, i) => {
      const n = normalizeNovelKey(v.site, k);
      if (n === null) ctx.addIssue({ code: "custom", message: "invalid novelKey", path: ["novelKeys", i] });
      else keys.push(n);
    });
    return { site: v.site, novelKeys: [...new Set(keys)], priority: v.priority ?? 0 };
  });

/** 作品単位の即時バックアップの制限(一般ユーザー / 管理者 / 全体)。10 分窓 */
const TRIGGER_WINDOW_MS = 10 * 60_000;
const TRIGGER_USER_MAX = 5;
const TRIGGER_ADMIN_MAX = 30;
const TRIGGER_GLOBAL_MAX = 30;

/** SSE(進捗)接続の上限と寿命 */
const SSE_PER_USER_MAX = 3;
const SSE_GLOBAL_MAX = 50;
const SSE_REVALIDATE_MS = 60_000;
const SSE_MAX_LIFETIME_MS = 30 * 60_000;

export interface BackupRoutesOptions {
  /** スケジューラ取得(省略時はグローバル。テストで差し替え) */
  getScheduler?: () => BackupScheduler;
}

function parseSiteParam(site: string): SiteId | null {
  return isSiteId(site) ? site : null;
}

function rateLimited(res: Response, retryAfter: number) {
  res.setHeader("Retry-After", String(retryAfter));
  res.status(429).json({ error: "rate_limited", retryAfter });
}

// 予期しない例外は Express 5 が共通エラーハンドラ(app.ts)へ渡し、ログのうえ 500 internal_error を返す
export function createBackupRoutes(db: Db, opts: BackupRoutesOptions = {}): Router {
  const router = Router();
  const repository = new BackupRepository(db);
  const scheduler = () => (opts.getScheduler ?? getBackupScheduler)();

  const userTriggerLimiter = new RateLimiter(TRIGGER_USER_MAX, TRIGGER_WINDOW_MS);
  const adminTriggerLimiter = new RateLimiter(TRIGGER_ADMIN_MAX, TRIGGER_WINDOW_MS);
  const globalTriggerLimiter = new RateLimiter(TRIGGER_GLOBAL_MAX, TRIGGER_WINDOW_MS);
  const sseByUser = new Map<number, number>();
  let sseTotal = 0;

  router.use(requireAuth);

  /**
   * GET /api/backup/status - バックアップ状態取得
   */
  router.get("/status", (_req, res) => {
    res.json(scheduler().getStatus());
  });

  /**
   * GET /api/backup/settings - バックアップ設定取得
   */
  router.get("/settings", (_req, res) => {
    const current = scheduler().getConfig();
    const persisted = readBackupScheduleSettings(db, {
      frequency: current.frequency,
      time: current.time || "03:00",
      maxParallel: current.maxParallel,
    });
    res.json({ settings: persisted });
  });

  /**
   * PUT /api/backup/settings - バックアップ設定更新(管理者のみ)
   */
  router.put("/settings", requireAdmin, (req, res) => {
    const parsed = settingsSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "validation_error", details: parsed.error.issues });
    const next = parsed.data;
    scheduler().updateConfig(next);
    writeBackupScheduleSettings(db, next);
    res.json({ settings: next, updatedAt: nowIso() });
  });

  /**
   * POST /api/backup/trigger - 手動バックアップトリガー
   */
  router.post("/trigger", requireAdmin, async (_req, res) => {
    await scheduler().trigger();
    res.json({ message: "Backup cycle triggered" });
  });

  /**
   * POST /api/backup/enqueue - バックアップキューに作品を追加
   * Body: { site: "narou"|"hameln"|"kakuyomu", novelKeys: string[](1〜200), priority?: 0〜100 }
   */
  router.post("/enqueue", requireAdmin, (req, res) => {
    const parsed = enqueueSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: "validation_error", details: parsed.error.issues });
    const { site, novelKeys, priority } = parsed.data;
    scheduler().enqueueNovel(site, novelKeys, priority);
    res.json({ message: `Enqueued ${novelKeys.length} novels`, count: novelKeys.length });
  });

  /**
   * POST /api/backup/novels/:site/:novelKey/trigger - 作品単位の即時バックアップ
   * 一般ユーザーも実行可。レート制限(ユーザー別 + 全体)超過は 429 { error: "rate_limited", retryAfter }。
   */
  router.post("/novels/:site/:novelKey/trigger", (req, res) => {
    const site = parseSiteParam(req.params.site);
    const novelKey = site ? normalizeNovelKey(site, String(req.params.novelKey ?? "")) : null;
    if (!site || !novelKey) return res.status(400).json({ error: "validation_error" });

    const user = req.user!;
    const userLimiter = user.role === "admin" ? adminTriggerLimiter : userTriggerLimiter;
    const userKey = `user:${user.id}`;
    if (!userLimiter.take(userKey)) return rateLimited(res, userLimiter.retryAfterSec(userKey));
    if (!globalTriggerLimiter.take("global")) return rateLimited(res, globalTriggerLimiter.retryAfterSec("global"));

    const s = scheduler();
    s.enqueueNovel(site, [novelKey], 100);
    // 実行中なら新たなサイクルは起動せず、キューへの追加のみ(合流)
    const alreadyRunning = s.getStatus().running;
    if (!alreadyRunning) {
      s.trigger().catch((e) => console.error("[Backup] manual trigger failed:", e));
    }
    res.json({ enqueued: true, site, novelKey, started: !alreadyRunning });
  });

  /**
   * GET /api/backup/novels/:site/:novelKey/episodes - 最新バックアップ本文一覧
   */
  router.get("/novels/:site/:novelKey/episodes", (req, res) => {
    const site = parseSiteParam(req.params.site);
    const novelKey = site ? normalizeNovelKey(site, String(req.params.novelKey ?? "")) : null;
    if (!site || !novelKey) return res.status(400).json({ error: "validation_error" });
    const episodes = repository.listLatestEpisodeContents(site, novelKey);
    res.json({ site, novelKey, episodes });
  });

  /**
   * GET /api/backup/progress - バックアップ進捗(SSE)
   * 接続数はユーザー別・全体で制限(超過は 429)。トークン失効の検知のため定期的に再検証し、最大寿命も設ける。
   */
  router.get("/progress", (req: Request, res: Response) => {
    const userId = req.user!.id;
    const perUser = sseByUser.get(userId) ?? 0;
    if (perUser >= SSE_PER_USER_MAX || sseTotal >= SSE_GLOBAL_MAX) {
      return rateLimited(res, 30);
    }
    sseByUser.set(userId, perUser + 1);
    sseTotal++;

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const send = (event: unknown) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    send({ phase: "idle", message: "connected", timestamp: nowIso() });
    const off = scheduler().onProgress((event) => send(event));
    const timer = setInterval(() => send({ phase: "idle", message: "heartbeat", timestamp: nowIso() }), 15000);
    const revalidate = setInterval(() => {
      if (!req.authToken || !resolveSession(db, req.authToken)) cleanup();
    }, SSE_REVALIDATE_MS);
    const lifetime = setTimeout(() => cleanup(), SSE_MAX_LIFETIME_MS);

    let closed = false;
    function cleanup() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      clearInterval(revalidate);
      clearTimeout(lifetime);
      off();
      const n = (sseByUser.get(userId) ?? 1) - 1;
      if (n <= 0) sseByUser.delete(userId);
      else sseByUser.set(userId, n);
      sseTotal--;
      res.end();
    }

    req.on("close", cleanup);
    res.on("close", cleanup);
  });

  return router;
}
