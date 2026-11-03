import { ref } from "vue";
import { ApiError, getReadingProgress, setEpisodeRead, type ApiConfig } from "../api";

/**
 * 既読状態。端末(localStorage)に楽観的にキャッシュし、サーバーへ PUT する。
 * PUT に失敗した変更は保留キューに残し、次の読み込み・再接続時に再送する。
 */
const CACHE_KEY = "read_progress_v1";
const PENDING_KEY = "read_pending_v1";

export interface LocalProgress {
  read: string[];
  lastReadEpisodeKey: string | null;
  lastReadAt: string | null;
}
interface PendingItem {
  site: string;
  novelKey: string;
  episodeKey: string;
  read: boolean;
}

/** 既読状態が変わるたびに増える。一覧側はこれを見て表示を更新する */
export const readVersion = ref(0);

const nk = (site: string, novelKey: string) => `${site}:${novelKey}`;

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function saveJson(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* 容量超過などは無視(次回サーバーから再取得できる) */
  }
}

const cache = (): Record<string, LocalProgress> => loadJson(CACHE_KEY, {});
const pending = (): PendingItem[] => loadJson(PENDING_KEY, []);

function applyItem(p: LocalProgress, key: string, read: boolean, at: string): LocalProgress {
  const set = new Set(p.read);
  if (read) set.add(key);
  else set.delete(key);
  return read ? { read: [...set], lastReadEpisodeKey: key, lastReadAt: at } : { ...p, read: [...set] };
}

/** この作品に未送信の変更があるか(あれば一覧の件数は端末側を優先する) */
export function hasPending(site: string, novelKey: string): boolean {
  return pending().some((p) => p.site === site && p.novelKey === novelKey);
}

/** 端末側の既読話数(キャッシュがなければ undefined) */
export function localReadCount(site: string, novelKey: string): number | undefined {
  return cache()[nk(site, novelKey)]?.read.length;
}

export function getLocalProgress(site: string, novelKey: string): LocalProgress {
  return cache()[nk(site, novelKey)] ?? { read: [], lastReadEpisodeKey: null, lastReadAt: null };
}

/** 保留中の変更をサーバーへ再送する。通信できなければ残す。401 は投げる。 */
let flushing = false;
export async function flushReadPending(cfg: ApiConfig): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    let queue = pending();
    while (queue.length > 0) {
      const it = queue[0];
      try {
        await setEpisodeRead(cfg, it.site, it.novelKey, it.episodeKey, it.read);
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) throw e;
        // 4xx(対象なし等)は再送しても無駄なので破棄して先へ。通信不可・5xx は残して次回再試行
        if (!(e instanceof ApiError && e.status < 500)) break;
      }
      queue = pending().slice(1);
      saveJson(PENDING_KEY, queue);
    }
  } finally {
    flushing = false;
    readVersion.value++;
  }
}

/** 作品の既読状態を読み込む。サーバーに繋がれば最新を端末へ反映、繋がらなければ端末のキャッシュを使う。 */
export async function loadProgress(cfg: ApiConfig, site: string, novelKey: string): Promise<LocalProgress> {
  try {
    await flushReadPending(cfg);
    const r = await getReadingProgress(cfg, site, novelKey);
    let p: LocalProgress = { read: r.readEpisodeKeys, lastReadEpisodeKey: r.lastReadEpisodeKey, lastReadAt: r.lastReadAt };
    // 送れなかった変更はサーバーの状態の上に重ねる
    const now = new Date().toISOString();
    for (const it of pending()) if (it.site === site && it.novelKey === novelKey) p = applyItem(p, it.episodeKey, it.read, now);
    const c = cache();
    c[nk(site, novelKey)] = p;
    saveJson(CACHE_KEY, c);
    readVersion.value++;
    return p;
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) throw e;
    return getLocalProgress(site, novelKey);
  }
}

/** 既読/未読を切り替える。端末へ即反映し、サーバーへ送る(失敗したら保留)。更新後の状態を返す。 */
export async function setRead(cfg: ApiConfig, site: string, novelKey: string, episodeKey: string, read: boolean): Promise<LocalProgress> {
  const c = cache();
  const next = applyItem(getLocalProgress(site, novelKey), episodeKey, read, new Date().toISOString());
  c[nk(site, novelKey)] = next;
  saveJson(CACHE_KEY, c);
  readVersion.value++;
  // 順序を保つため、先に保留キューへ積んでから送る
  saveJson(PENDING_KEY, [...pending(), { site, novelKey, episodeKey, read }]);
  try {
    await flushReadPending(cfg);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) throw e;
  }
  return next;
}
