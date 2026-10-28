/** お知らせ(端末内通知)の純粋なストア操作。永続化は stores/notifications.ts。 */
export interface AppNotification {
  id: string;
  /** 通知の種類(例: "offline-saved", "backup-done") */
  kind: string;
  title: string;
  body: string;
  /** ISO 8601 */
  createdAt: string;
  read: boolean;
}

export interface NotifyInput {
  kind: string;
  title: string;
  body?: string;
}

export const MAX_NOTIFICATIONS = 200;

export function addNotification(list: readonly AppNotification[], input: NotifyInput, id: string, now: Date = new Date()): AppNotification[] {
  const n: AppNotification = { id, kind: input.kind, title: input.title, body: input.body ?? "", createdAt: now.toISOString(), read: false };
  return [n, ...list].slice(0, MAX_NOTIFICATIONS);
}
export function markRead(list: readonly AppNotification[], id: string): AppNotification[] {
  return list.map((n) => (n.id === id && !n.read ? { ...n, read: true } : n));
}
export function markAllRead(list: readonly AppNotification[]): AppNotification[] {
  return list.map((n) => (n.read ? n : { ...n, read: true }));
}
export function removeNotification(list: readonly AppNotification[], id: string): AppNotification[] {
  return list.filter((n) => n.id !== id);
}
export function unreadCount(list: readonly AppNotification[]): number {
  return list.reduce((c, n) => c + (n.read ? 0 : 1), 0);
}
export function sanitizeNotifications(input: unknown): AppNotification[] {
  if (!Array.isArray(input)) return [];
  const out: AppNotification[] = [];
  for (const v of input) {
    if (!v || typeof v !== "object") continue;
    const o = v as Record<string, unknown>;
    if (typeof o.id !== "string" || typeof o.title !== "string" || typeof o.createdAt !== "string") continue;
    out.push({
      id: o.id,
      kind: typeof o.kind === "string" ? o.kind : "",
      title: o.title,
      body: typeof o.body === "string" ? o.body : "",
      createdAt: o.createdAt,
      read: o.read === true,
    });
  }
  return out.slice(0, MAX_NOTIFICATIONS);
}
