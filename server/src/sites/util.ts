import { SiteBlockedError } from "./types.js";

/** JST の日時要素から UTC ISO8601 を作る。 */
export function jstToIso(y: number, mo: number, d: number, h = 0, mi = 0, s = 0): string {
  return new Date(Date.UTC(y, mo - 1, d, h - 9, mi, s)).toISOString();
}

const DATE_RE =
  /(\d{4})\s*[/\-年]\s*(\d{1,2})\s*[/\-月]\s*(\d{1,2})\s*日?(?:\s*[(（][^)）]*[)）])?(?:\s*(\d{1,2}):(\d{2})(?::(\d{2}))?)?/;

/** 「2012/11/22 17:00」「2012-11-22 17:00:34」「2016年03月04日(金) 12:06」等(JST)を ISO8601(UTC) に。 */
export function parseJstDate(text: string | undefined | null): string | undefined {
  if (!text) return undefined;
  const m = DATE_RE.exec(text);
  if (!m) return undefined;
  return jstToIso(+m[1]!, +m[2]!, +m[3]!, m[4] ? +m[4] : 0, m[5] ? +m[5] : 0, m[6] ? +m[6] : 0);
}

/** 取得 HTML が Cloudflare チャレンジ等なら理由を返す。 */
export function detectBlockedHtml(html: string): { reason: "challenge" | "age-gate"; message: string } | null {
  const head = html.slice(0, 6000);
  if (/<title>\s*Just a moment/i.test(head) || /cf-chl|challenge-platform|cf-browser-verification/i.test(html.slice(0, 20000))) {
    return { reason: "challenge", message: "Cloudflare challenge page returned" };
  }
  return null;
}

export function assertNotBlocked(html: string): void {
  const b = detectBlockedHtml(html);
  if (b) throw new SiteBlockedError(b.message, b.reason);
}

/** 最初に見つかったセレクタ(フォールバック列)を返す。 */
export function firstNonEmpty<T>(candidates: Array<() => T | undefined | null | "">): T | undefined {
  for (const c of candidates) {
    const v = c();
    if (v) return v as T;
  }
  return undefined;
}
