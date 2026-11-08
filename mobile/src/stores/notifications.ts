import { computed, ref } from "vue";
import { Preferences } from "@capacitor/preferences";
import {
  deleteAllNotifications,
  deleteNotification as deleteNotificationApi,
  listNotifications,
  markAllNotificationsAsRead,
  markNotificationAsRead,
  type ApiConfig,
  type Notification,
} from "../api";
import {
  addNotification,
  markAllRead as markAll,
  markRead as markOne,
  removeNotification,
  sanitizeNotifications,
  unreadCount,
  type AppNotification,
  type NotifyInput,
} from "../logic/notifications";

const KEY = "notifications";
/** サーバーのお知らせを 1 回に読む件数 */
export const NOTIFICATION_PAGE = 30;

export const notifications = ref<AppNotification[]>([]);
/** サーバー側の全体の未読数・全件数(同期前は null。未取得のページの分も含む) */
const serverUnread = ref<number | null>(null);
const serverTotal = ref<number | null>(null);
const serverLoaded = computed(() => notifications.value.filter((n) => n.serverId !== undefined).length);

/** 未読数。同期後はサーバーの未読数(未取得のページも含む)+ 端末内の未読 */
export const unread = computed(() =>
  serverUnread.value === null
    ? unreadCount(notifications.value)
    : serverUnread.value + unreadCount(notifications.value.filter((n) => n.serverId === undefined)),
);
/** サーバーにまだ読み込んでいないお知らせがあるか */
export const hasMoreNotifications = computed(() => serverTotal.value !== null && serverLoaded.value < serverTotal.value);
/** 一覧の全件数(未取得のページも含む) */
export const notificationTotal = computed(() =>
  serverTotal.value === null ? notifications.value.length : serverTotal.value + notifications.value.filter((n) => n.serverId === undefined).length,
);

async function persist() {
  try {
    await Preferences.set({ key: KEY, value: JSON.stringify(notifications.value) });
  } catch {
    /* 保存失敗は無視(メモリ上には残る) */
  }
}

export async function loadNotifications() {
  try {
    const v = (await Preferences.get({ key: KEY })).value;
    notifications.value = v ? sanitizeNotifications(JSON.parse(v)) : [];
  } catch {
    notifications.value = [];
  }
}

let seq = 0;
export function notify(input: NotifyInput): void {
  const id = `${Date.now().toString(36)}-${(seq++).toString(36)}`;
  notifications.value = addNotification(notifications.value, input, id);
  void persist();
}

function toApp(n: Notification): AppNotification {
  return { id: `server:${n.id}`, serverId: n.id, kind: n.type, title: n.title, body: n.message ?? "", createdAt: n.createdAt, read: n.read };
}

function byNewest(list: AppNotification[]): AppNotification[] {
  return list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// 先頭ページの取り直しと追加読み込みが重なったとき、古い応答で上書きしない
let syncSeq = 0;

/** サーバーのお知らせを先頭ページから取り直す(読み込み済みの続きのページは捨てる) */
export async function syncNotifications(cfg: ApiConfig): Promise<void> {
  const my = ++syncSeq;
  const remote = await listNotifications(cfg, NOTIFICATION_PAGE);
  if (my !== syncSeq) return;
  const locals = notifications.value.filter((n) => n.serverId === undefined);
  notifications.value = byNewest([...remote.notifications.map(toApp), ...locals]);
  serverUnread.value = remote.unreadCount;
  serverTotal.value = remote.total;
  void persist();
}

/** サーバーのお知らせの次のページを読み込む */
export async function loadMoreNotifications(cfg: ApiConfig): Promise<void> {
  const my = ++syncSeq;
  const remote = await listNotifications(cfg, NOTIFICATION_PAGE, serverLoaded.value);
  if (my !== syncSeq) return;
  const known = new Set(notifications.value.map((n) => n.serverId).filter((id) => id !== undefined));
  const added = remote.notifications.filter((n) => !known.has(n.id)).map(toApp);
  notifications.value = byNewest([...notifications.value, ...added]);
  serverUnread.value = remote.unreadCount;
  serverTotal.value = remote.total;
  void persist();
}

export async function markRead(id: string, cfg?: ApiConfig): Promise<void> {
  const before = notifications.value.find((x) => x.id === id);
  notifications.value = markOne(notifications.value, id);
  if (before?.serverId !== undefined && !before.read && serverUnread.value !== null) serverUnread.value = Math.max(0, serverUnread.value - 1);
  if (before?.serverId !== undefined && cfg) {
    await markNotificationAsRead(cfg, before.serverId);
  }
  void persist();
}

/** すべて既読(サーバー側は未取得のページも含めて既読にする) */
export async function markAllRead(cfg?: ApiConfig): Promise<void> {
  notifications.value = markAll(notifications.value);
  if (cfg) {
    await markAllNotificationsAsRead(cfg);
    serverUnread.value = 0;
  }
  void persist();
}

export async function dismiss(id: string, cfg?: ApiConfig): Promise<void> {
  const target = notifications.value.find((n) => n.id === id);
  notifications.value = removeNotification(notifications.value, id);
  if (target?.serverId !== undefined && cfg) {
    await deleteNotificationApi(cfg, target.serverId);
    if (!target.read && serverUnread.value !== null) serverUnread.value = Math.max(0, serverUnread.value - 1);
    if (serverTotal.value !== null) serverTotal.value = Math.max(0, serverTotal.value - 1);
  }
  void persist();
}

/** すべて削除(サーバー側は未取得のページも含めて削除する) */
export async function clearAllNotifications(cfg: ApiConfig): Promise<void> {
  await deleteAllNotifications(cfg);
  notifications.value = [];
  serverUnread.value = 0;
  serverTotal.value = 0;
  void persist();
}

export function clearLocalNotifications() {
  notifications.value = notifications.value.filter((n) => n.serverId !== undefined);
  void persist();
}
