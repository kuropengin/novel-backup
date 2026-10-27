import { loadConfig } from "../config.js";
import { SiteBlockedError, SiteNotFoundError } from "../sites/types.js";

export interface PoliteFetchOptions {
  /** 'interactive' はキュー先頭に入り、間隔は最大 300ms に短縮。既定 'normal' */
  priority?: "normal" | "interactive";
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** リトライ回数(既定 3) */
  maxRetries?: number;
  /** true なら本文をバイナリ(`body`)で返す(画像/フォント等)。`text` は空文字 */
  binary?: boolean;
}

export interface PoliteFetchResult {
  status: number;
  /** 最終 URL(リダイレクト後) */
  url: string;
  headers: Headers;
  text: string;
  /** `binary: true` の時のみ */
  body?: Buffer;
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    message?: string,
  ) {
    super(message ?? `HTTP ${status} for ${url}`);
    this.name = "HttpError";
  }
}

export interface PoliteFetcherDeps {
  /** 通常間隔(ms)。設定値から取得する関数を注入する */
  getIntervalMs: () => number;
  fetchImpl: typeof fetch;
  userAgent: string;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** バックオフ基準(ms)。テストで短縮 */
  backoffBaseMs: number;
  /** Retry-After の上限(ms) */
  maxRetryAfterMs: number;
  interactiveIntervalMs: number;
  /** ハーメルン向けの Cookie / UA。リクエスト毎に呼ばれる(設定変更が再起動なしで反映される) */
  getHamelnAuth: () => { cookie: string; userAgent: string };
}

/** ハーメルンのホストか(syosetu.org とそのサブドメイン。syosetu.com=なろう は含まない) */
export function isHamelnHost(host: string): boolean {
  const h = host.toLowerCase().replace(/:\d+$/, "");
  return h === "syosetu.org" || h.endsWith(".syosetu.org");
}

const MAX_REDIRECTS = 5;

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_RETRIES = 3;

export function defaultDeps(): PoliteFetcherDeps {
  return {
    getIntervalMs: () => 1500,
    fetchImpl: (...args) => fetch(...args),
    userAgent: loadConfig().userAgent,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    backoffBaseMs: 2000,
    maxRetryAfterMs: 60_000,
    interactiveIntervalMs: 300,
    getHamelnAuth: () => ({ cookie: "", userAgent: "" }),
  };
}

function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (!value) return undefined;
  const sec = Number(value);
  if (Number.isFinite(sec)) return Math.max(0, sec * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/** Cloudflare 等のボット判定ページか。 */
export function isChallengeResponse(status: number, headers: Headers, text: string): boolean {
  if (headers.get("cf-mitigated")?.toLowerCase() === "challenge") return true;
  if ((status === 403 || status === 503) && /<title>\s*Just a moment|cf-chl|challenge-platform/i.test(text.slice(0, 20000))) {
    return true;
  }
  return false;
}

interface Job {
  url: string;
  opts: PoliteFetchOptions;
  resolve: (r: PoliteFetchResult) => void;
  reject: (e: unknown) => void;
}

interface HostQueue {
  interactive: Job[];
  normal: Job[];
  running: boolean;
  lastFinishedAt: number;
}

export function createPoliteFetcher(overrides: Partial<PoliteFetcherDeps> = {}) {
  const deps: PoliteFetcherDeps = { ...defaultDeps(), ...overrides };
  const queues = new Map<string, HostQueue>();

  function getQueue(host: string): HostQueue {
    let q = queues.get(host);
    if (!q) {
      q = { interactive: [], normal: [], running: false, lastFinishedAt: -Infinity };
      queues.set(host, q);
    }
    return q;
  }

  /**
   * 1 回の取得。ハーメルン宛で Cookie があるときは redirect を手動で辿り、
   * Cookie / UA は各ホップの宛先がハーメルンの場合にのみ付ける(他ホストへ漏らさない)。
   */
  async function requestOnce(startUrl: string, opts: PoliteFetchOptions, timeoutMs: number): Promise<Response> {
    const auth = isHamelnHost(new URL(startUrl).host) ? deps.getHamelnAuth() : { cookie: "", userAgent: "" };
    const build = (u: string): Record<string, string> => {
      const hameln = isHamelnHost(new URL(u).host);
      return {
        "User-Agent": hameln && auth.userAgent ? auth.userAgent : deps.userAgent,
        "Accept-Language": "ja",
        Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
        ...(hameln && auth.cookie ? { Cookie: auth.cookie } : {}),
        ...opts.headers,
      };
    };
    const signal = AbortSignal.timeout(timeoutMs);
    if (!auth.cookie) return deps.fetchImpl(startUrl, { redirect: "follow", signal, headers: build(startUrl) });
    let current = startUrl;
    for (let hop = 0; ; hop++) {
      const res = await deps.fetchImpl(current, { redirect: "manual", signal, headers: build(current) });
      const loc = res.headers.get("location");
      if (res.status < 300 || res.status >= 400 || !loc || res.status === 304) return res;
      if (hop >= MAX_REDIRECTS) throw new HttpError(res.status, current, "Too many redirects");
      current = new URL(loc, current).toString();
    }
  }

  async function execute(job: Job): Promise<PoliteFetchResult> {
    const { url, opts } = job;
    const maxRetries = opts.maxRetries ?? DEFAULT_RETRIES;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      let retryAfterMs: number | undefined;
      try {
        const res = await requestOnce(url, opts, timeoutMs);
        const binary = opts.binary === true;
        const buf = binary ? Buffer.from(await res.arrayBuffer()) : null;
        // バイナリ時はエラー応答(チャレンジ判定が必要な場合)のみ文字列化する
        const text = buf ? (res.status >= 400 ? buf.toString("utf8", 0, 20000) : "") : await res.text();
        if (isChallengeResponse(res.status, res.headers, text)) {
          throw new SiteBlockedError(`Blocked by bot challenge: ${url}`, "challenge");
        }
        if (res.status === 404 || res.status === 410) throw new SiteNotFoundError(`${res.status} ${url}`);
        if (res.status === 429 || res.status >= 500) {
          retryAfterMs = parseRetryAfter(res.headers.get("retry-after"), deps.now());
          lastError = new HttpError(res.status, url);
          // fallthrough to retry
        } else if (res.status >= 400) {
          throw new HttpError(res.status, url);
        } else {
          return { status: res.status, url: res.url || url, headers: res.headers, text, ...(buf ? { body: buf } : {}) };
        }
      } catch (e) {
        if (e instanceof SiteNotFoundError || e instanceof SiteBlockedError || e instanceof HttpError) throw e;
        lastError = e; // ネットワークエラー / タイムアウト
      }
      if (attempt < maxRetries) {
        const backoff = deps.backoffBaseMs * 2 ** attempt;
        const wait = Math.min(Math.max(retryAfterMs ?? 0, backoff), Math.max(deps.maxRetryAfterMs, backoff));
        await deps.sleep(wait);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async function pump(q: HostQueue): Promise<void> {
    if (q.running) return;
    q.running = true;
    try {
      for (;;) {
        const job = q.interactive.shift() ?? q.normal.shift();
        if (!job) break;
        const base = deps.getIntervalMs();
        const interval = job.opts.priority === "interactive" ? Math.min(base, deps.interactiveIntervalMs) : base;
        const wait = q.lastFinishedAt + interval - deps.now();
        if (wait > 0) await deps.sleep(wait);
        try {
          job.resolve(await execute(job));
        } catch (e) {
          job.reject(e);
        } finally {
          q.lastFinishedAt = deps.now();
        }
      }
    } finally {
      q.running = false;
    }
  }

  function politeFetch(url: string, opts: PoliteFetchOptions = {}): Promise<PoliteFetchResult> {
    const host = new URL(url).host;
    return new Promise<PoliteFetchResult>((resolve, reject) => {
      const q = getQueue(host);
      (opts.priority === "interactive" ? q.interactive : q.normal).push({ url, opts, resolve, reject });
      void pump(q);
    });
  }

  return { politeFetch, deps };
}

// ---- モジュール既定インスタンス ----
let instance = createPoliteFetcher();

/** 起動時に設定値(requestIntervalMs)取得関数などを注入する。例: configurePoliteFetch({ getIntervalMs: () => getSettings(db).requestIntervalMs }) */
export function configurePoliteFetch(overrides: Partial<PoliteFetcherDeps>): void {
  instance = createPoliteFetcher({ ...instance.deps, ...overrides });
}

/** ハーメルンの Cookie が設定されているか(エラーメッセージ用) */
export function isHamelnCookieConfigured(): boolean {
  try {
    return instance.deps.getHamelnAuth().cookie.length > 0;
  } catch {
    return false;
  }
}

export function politeFetch(url: string, opts?: PoliteFetchOptions): Promise<PoliteFetchResult> {
  return instance.politeFetch(url, opts);
}
