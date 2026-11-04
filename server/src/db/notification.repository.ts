import type { DatabaseSync } from "node:sqlite";

export interface Notification {
  id: number;
  userId: number;
  type: "backup" | "error";
  title: string;
  message?: string;
  novelKey?: string;
  read: boolean;
  createdAt: string;
}

export class NotificationRepository {
  constructor(private db: DatabaseSync) {}

  /**
   * 通知を作成
   */
  createNotification(userId: number, type: "backup" | "error", title: string, message?: string, novelKey?: string): Notification {
    const createdAt = new Date().toISOString();
    const stmt = this.db.prepare(
      `INSERT INTO notifications (user_id, type, title, message, novel_key, read, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?)`
    );
    const result = stmt.run(userId, type, title, message || null, novelKey || null, createdAt);
    return {
      id: result.lastInsertRowid as number,
      userId,
      type,
      title,
      message,
      novelKey,
      read: false,
      createdAt,
    };
  }

  /**
   * 作品の更新通知を、その作品をブックマークしている全ユーザーに 1 件ずつ作成する。
   * 作成した通知数を返す。新着 / 改稿がともに 0 なら何もしない。
   */
  notifyNovelUpdate(site: string, novelKey: string, newCount: number, revisedCount: number): number {
    if (newCount <= 0 && revisedCount <= 0) return 0;
    const novel = this.db
      .prepare(`SELECT id, title FROM novels WHERE site = ? AND novel_key = ?`)
      .get(site, novelKey) as { id: number; title: string } | undefined;
    if (!novel) return 0;
    const users = this.db
      .prepare(`SELECT DISTINCT user_id FROM bookmarks WHERE novel_id = ?`)
      .all(novel.id) as Array<{ user_id: number }>;
    const parts: string[] = [];
    if (newCount > 0) parts.push(`新着 ${newCount}話`);
    if (revisedCount > 0) parts.push(`改稿 ${revisedCount}話`);
    const title = `${novel.title || novelKey} が更新されました`;
    const message = parts.join("・");
    for (const u of users) this.createNotification(u.user_id, "backup", title, message, novelKey);
    return users.length;
  }

  /**
   * ユーザーの通知一覧を取得
   */
  listNotifications(userId: number, limit: number = 50): Notification[] {
    const stmt = this.db.prepare(
      `SELECT id, user_id as userId, type, title, message, novel_key as novelKey, read, created_at as createdAt
       FROM notifications
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT ?`
    );
    return (stmt.all(userId, limit) as any[]).map((r) => ({
      ...r,
      read: !!r.read,
    }));
  }

  /**
   * 未読通知の数
   */
  getUnreadCount(userId: number): number {
    const row = this.db.prepare(`SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND read = 0`).get(userId) as {
      count: number;
    };
    return row.count;
  }

  /**
   * 通知を既読にする
   */
  markAsRead(userId: number, notificationId: number): void {
    const stmt = this.db.prepare(`UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?`);
    stmt.run(notificationId, userId);
  }

  /**
   * 通知を削除
   */
  deleteNotification(userId: number, notificationId: number): void {
    const stmt = this.db.prepare(`DELETE FROM notifications WHERE id = ? AND user_id = ?`);
    stmt.run(notificationId, userId);
  }
}
