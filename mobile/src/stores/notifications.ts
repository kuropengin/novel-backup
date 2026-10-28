import { computed, ref } from "vue";
import { Preferences } from "@capacitor/preferences";
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
/** お知らせを追加する。端末保存完了・バックアップ完了などの発生源から呼ぶ(今回は発生源なし)。 */
export function notify(input: NotifyInput): void {
  const id = `${Date.now().toString(36)}-${(seq++).toString(36)}`;
  notifications.value = addNotification(notifications.value, input, id);
  void persist();
}
export function markRead(id: string) {
  notifications.value = markOne(notifications.value, id);
  void persist();
}
export function markAllRead() {
  notifications.value = markAll(notifications.value);
  void persist();
}
export function dismiss(id: string) {
  notifications.value = removeNotification(notifications.value, id);
  void persist();
}
export function clearNotifications() {
  notifications.value = [];
  void persist();
}
