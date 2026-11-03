/** 各サイトの日時表記を ISO 8601 (UTC, 末尾 Z) へ正規化する。 */

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/**
 * 空/解釈不能なら null。
 * - タイムゾーン付き ISO はそのまま UTC に変換
 * - "2026/10/03 11:00"・"2026-10-03 11:00:05"・"2026年10月03日(土) 11:00" はタイムゾーン無しなので JST として扱う
 * - "2026/10/03" のみの場合は JST 0:00
 */
export function normalizeSourceDate(raw: string | null | undefined): string | null {
  const s = (raw ?? "").replace("改稿", "").trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  }
  const m = /^(\d{4})[/年.-](\d{1,2})[/月.-](\d{1,2})日?(?:\s*[(（][^)）]*[)）])?(?:[\sT]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (!m) return null;
  const [, y, mo, d, h, mi, se] = m;
  const utc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h ?? 0), Number(mi ?? 0), Number(se ?? 0));
  if (Number.isNaN(utc)) return null;
  return new Date(utc - JST_OFFSET_MS).toISOString();
}
