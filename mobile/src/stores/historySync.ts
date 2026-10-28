import { Preferences } from "@capacitor/preferences";
import { ApiError, NetworkError, postHistory, type ApiConfig } from "../api";
import { enqueue, flushQueue, sanitizeQueue, type QueuedView, type SendResult } from "../logic/historyQueue";
import { online } from "./network";

const KEY = "historyQueue";
let queue: QueuedView[] | null = null;
let flushing = false;

async function load(): Promise<QueuedView[]> {
  if (queue) return queue;
  try {
    const v = (await Preferences.get({ key: KEY })).value;
    queue = v ? sanitizeQueue(JSON.parse(v)) : [];
  } catch {
    queue = [];
  }
  return queue;
}
async function save(q: QueuedView[]) {
  queue = q;
  try {
    if (q.length) await Preferences.set({ key: KEY, value: JSON.stringify(q) });
    else await Preferences.remove({ key: KEY });
  } catch {
    /* 保存失敗は無視 */
  }
}

async function sendOne(cfg: ApiConfig, v: QueuedView): Promise<SendResult> {
  try {
    await postHistory(cfg, v);
    return "ok";
  } catch (e) {
    if (e instanceof NetworkError) return "retry";
    if (e instanceof ApiError) return e.status === 401 || e.status >= 500 ? "stop" : "drop"; // 400 not_a_novel_page 等は再送しても無駄
    return "drop";
  }
}

/** 溜まっている履歴を送信。 */
export async function flushHistory(cfg: ApiConfig): Promise<void> {
  if (flushing || !cfg.token) return;
  flushing = true;
  try {
    const q = await load();
    if (q.length === 0) return;
    await save(await flushQueue(q, (v) => sendOne(cfg, v)));
  } finally {
    flushing = false;
  }
}

/**
 * ページ 1 読み込みにつき 1 回呼ぶ。オフライン/送信不可なら端末のキューへ積む。
 * @returns false なら 401(再ログインが必要)
 */
export async function recordView(cfg: ApiConfig, v: Omit<QueuedView, "viewedAt">): Promise<boolean> {
  const item: QueuedView = { ...v, viewedAt: new Date().toISOString() };
  if (online.value) {
    try {
      await postHistory(cfg, item);
      void flushHistory(cfg); // 通信できたので溜まっている分も送る
      return true;
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.status === 401) return false;
        if (e.status < 500) return true; // 400 not_a_novel_page 等は再送しても無駄
      }
      // 通信不可・5xx はキューへ
    }
  }
  await save(enqueue(await load(), item));
  return true;
}
