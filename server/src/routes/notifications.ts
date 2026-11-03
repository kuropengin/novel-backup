import { Router } from "express";
import { requireAuth } from "../auth/session.js";
import type { AppContext } from "../index.js";

/** 10 進数の正整数のみ受け付ける("12abc" や "1e3" は不可) */
function parseId(raw: unknown): number | null {
  const s = String(raw);
  if (!/^\d{1,15}$/.test(s)) return null;
  return Number(s);
}

// 予期しない例外は Express 5 が共通エラーハンドラ(app.ts)へ渡し、500 internal_error を返す
export function notificationsRouter(ctx: AppContext): Router {
  const router = Router();

  /**
   * GET /api/notifications
   * ユーザーの通知一覧を取得
   */
  router.get("/", requireAuth, (req, res) => {
    const userId = req.user!.id;
    const notifications = ctx.notificationRepository.listNotifications(userId);
    const unreadCount = ctx.notificationRepository.getUnreadCount(userId);
    res.json({ notifications, unreadCount });
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
