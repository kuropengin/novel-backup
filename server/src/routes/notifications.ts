import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth/session.js";
import type { AppContext } from "../index.js";

/** 10 進数の正整数のみ受け付ける("12abc" や "1e3" は不可) */
function parseId(raw: unknown): number | null {
  const s = String(raw);
  if (!/^\d{1,15}$/.test(s)) return null;
  return Number(s);
}

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

// 予期しない例外は Express 5 が共通エラーハンドラ(app.ts)へ渡し、500 internal_error を返す
export function notificationsRouter(ctx: AppContext): Router {
  const router = Router();

  /**
   * GET /api/notifications?limit=&offset=
   * ユーザーの通知一覧を新しい順にページ取得。total は全件数、unreadCount は全体の未読数
   */
  router.get("/", requireAuth, (req, res) => {
    const parsed = listSchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: "validation_error" });
    const userId = req.user!.id;
    const notifications = ctx.notificationRepository.listNotifications(userId, parsed.data.limit, parsed.data.offset);
    const unreadCount = ctx.notificationRepository.getUnreadCount(userId);
    const total = ctx.notificationRepository.countNotifications(userId);
    res.json({ notifications, unreadCount, total });
  });

  /**
   * POST /api/notifications/read-all
   * 未取得のページも含めて、すべて既読にする
   */
  router.post("/read-all", requireAuth, (req, res) => {
    ctx.notificationRepository.markAllAsRead(req.user!.id);
    res.json({ ok: true });
  });

  /**
   * POST /api/notifications/:id/read
   * 通知を既読にする
   */
  router.post("/:id/read", requireAuth, (req, res) => {
    const notificationId = parseId(req.params.id);
    if (notificationId === null) return res.status(400).json({ error: "validation_error" });
    ctx.notificationRepository.markAsRead(req.user!.id, notificationId);
    res.json({ ok: true });
  });

  /**
   * DELETE /api/notifications
   * 未取得のページも含めて、すべて削除する
   */
  router.delete("/", requireAuth, (req, res) => {
    ctx.notificationRepository.deleteAllNotifications(req.user!.id);
    res.json({ ok: true });
  });

  /**
   * DELETE /api/notifications/:id
   * 通知を削除
   */
  router.delete("/:id", requireAuth, (req, res) => {
    const notificationId = parseId(req.params.id);
    if (notificationId === null) return res.status(400).json({ error: "validation_error" });
    ctx.notificationRepository.deleteNotification(req.user!.id, notificationId);
    res.json({ ok: true });
  });

  return router;
}
