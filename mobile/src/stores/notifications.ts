import { computed, ref } from "vue";
import { Preferences } from "@capacitor/preferences";
import { deleteNotification as deleteNotificationApi, listNotifications, markNotificationAsRead, type ApiConfig } from "../api";
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

export const notifications = ref<AppNotification[]>([]);
export const unread = computed(() => unreadCount(notifications.value));

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

export async function syncNotifications(cfg: ApiConfig): Promise<void> {
  const remote = await listNotifications(cfg);
  const locals = notifications.value.filter((n) => n.serverId === undefined);
  const serverMapped: AppNotification[] = remote.notifications.map((n) => ({
    id: `server:${n.id}`,
    serverId: n.id,
    kind: n.type,
    title: n.title,
    body: n.message ?? "",
    createdAt: n.createdAt,
    read: n.read,
  }));
  notifications.value = [...serverMapped, ...locals].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  void persist();
}

export async function markRead(id: string, cfg?: ApiConfig): Promise<void> {
  notifications.value = markOne(notifications.value, id);
  const n = notifications.value.find((x) => x.id === id);
  if (n?.serverId !== undefined && cfg) {
    await markNotificationAsRead(cfg, n.serverId);
  }
  void persist();
}

export async function markAllRead(cfg?: ApiConfig): Promise<void> {
  notifications.value = markAll(notifications.value);
  if (cfg) {
    const jobs = notifications.value
      .filter((n) => n.serverId !== undefined)
      .map((n) => markNotificationAsRead(cfg, n.serverId!));
    await Promise.all(jobs);
  }
  void persist();
}

export async function dismiss(id: string, cfg?: ApiConfig): Promise<void> {
  const target = notifications.value.find((n) => n.id === id);
  notifications.value = removeNotification(notifications.value, id);
  if (target?.serverId !== undefined && cfg) await deleteNotificationApi(cfg, target.serverId);
  void persist();
}

export function clearLocalNotifications() {
  notifications.value = notifications.value.filter((n) => n.serverId !== undefined);
  void persist();
}
