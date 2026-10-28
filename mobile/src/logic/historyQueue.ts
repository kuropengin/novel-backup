/** 閲覧履歴の送信キュー(オフライン時に端末へ溜め、復帰後に送る)。純粋関数のみ。 */
export interface QueuedView {
  url: string;
  novelTitle: string;
  episodeTitle: string;
  /** ISO 8601 */
  viewedAt: string;
}

export const MAX_QUEUE = 200;

/** 追加。同じ URL は最新の 1 件だけ残し、上限を超えたら古い方から捨てる。 */
export function enqueue(queue: readonly QueuedView[], item: QueuedView, max = MAX_QUEUE): QueuedView[] {
  const next = queue.filter((q) => q.url !== item.url);
  next.push(item);
  return next.length > max ? next.slice(next.length - max) : next;
}

/** "ok" 送信済み / "drop" 再送しても無駄(400 等) / "retry" 通信不可 / "stop" 認証切れ等。retry・stop は以降を中断して残す */
export type SendResult = "ok" | "drop" | "retry" | "stop";

/** 古い順に送る。retry/stop が出たらそこで中断し、未送信分を返す。 */
export async function flushQueue(queue: readonly QueuedView[], send: (q: QueuedView) => Promise<SendResult>): Promise<QueuedView[]> {
  const rest = [...queue].sort((a, b) => a.viewedAt.localeCompare(b.viewedAt));
  while (rest.length > 0) {
    const r = await send(rest[0]!);
    if (r === "retry" || r === "stop") break;
    rest.shift();
  }
  return rest;
}

/** 保存値(外部入力)を安全な配列へ。 */
export function sanitizeQueue(input: unknown): QueuedView[] {
  if (!Array.isArray(input)) return [];
  const out: QueuedView[] = [];
  for (const v of input) {
    if (!v || typeof v !== "object") continue;
    const o = v as Record<string, unknown>;
    if (typeof o.url !== "string" || typeof o.viewedAt !== "string") continue;
    out.push({
      url: o.url,
      novelTitle: typeof o.novelTitle === "string" ? o.novelTitle : "",
      episodeTitle: typeof o.episodeTitle === "string" ? o.episodeTitle : "",
      viewedAt: o.viewedAt,
    });
  }
  return out.slice(-MAX_QUEUE);
}
