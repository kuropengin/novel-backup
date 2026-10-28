/** 対応 3 サイトの URL 判定(server/src/sites.ts の resolveUrl と同じ規則。純粋関数)。 */
export type SiteId = "hameln" | "narou" | "kakuyomu";

export const SITE_LABELS: Record<SiteId, string> = { hameln: "ハーメルン", narou: "なろう", kakuyomu: "カクヨム" };
export const SITE_COLORS: Record<SiteId, string> = { hameln: "#e8892b", narou: "#3aa76d", kakuyomu: "#27a6d4" };

export function siteLabel(site: string): string {
  return SITE_LABELS[site as SiteId] ?? site;
}
export function siteColor(site: string): string {
  return SITE_COLORS[site as SiteId] ?? "#8b98a5";
}

export interface PageKind {
  site: SiteId;
  kind: "novel" | "episode";
}

/** 作品ページ/話ページなら種別を返す。それ以外(トップ・一覧など)は null。 */
export function classifyUrl(input: string): PageKind | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase();
  if (host === "ncode.syosetu.com") {
    const m = /^\/(n\d{4}[a-z]{1,2})(?:\/(\d+))?\/?$/i.exec(url.pathname);
    return m ? { site: "narou", kind: m[2] ? "episode" : "novel" } : null;
  }
  if (host === "syosetu.org" || host === "www.syosetu.org") {
    const m = /^\/novel\/(\d+)(?:\/(?:(\d+)\.html)?)?$/.exec(url.pathname);
    if (m) return { site: "hameln", kind: m[2] ? "episode" : "novel" };
    const nid = url.searchParams.get("nid");
    if (url.searchParams.get("mode") === "ss_detail" && nid && /^\d+$/.test(nid)) return { site: "hameln", kind: "novel" };
    return null;
  }
  if (host === "kakuyomu.jp") {
    const m = /^\/works\/(\d+)(?:\/episodes\/(\d+))?\/?$/.exec(url.pathname);
    return m ? { site: "kakuyomu", kind: m[2] ? "episode" : "novel" } : null;
  }
  return null;
}

/**
 * アプリ内(SiteView)で開いてよいホスト(サブドメイン含む)。唯一の許可リスト。
 * 注意: SiteViewPlugin.java の ALLOWED_HOST_SUFFIXES / isAllowedHost / isInAppUrl と必ず一致させること。
 */
export const ALLOWED_HOST_SUFFIXES = ["syosetu.org", "syosetu.com", "kakuyomu.jp"] as const;

export function isAllowedHost(host: string | null | undefined): boolean {
  if (!host) return false;
  const h = host.toLowerCase();
  return ALLOWED_HOST_SUFFIXES.some((s) => h === s || h.endsWith("." + s));
}

/** アプリ内で開いてよい URL か(許可ホストの http(s)、または about/data/blob)。 */
export function isInAppUrl(input: string): boolean {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return false;
  }
  if (url.protocol === "http:" || url.protocol === "https:") return isAllowedHost(url.hostname);
  return url.protocol === "about:" || url.protocol === "data:" || url.protocol === "blob:";
}

/**
 * 外部リンクの開き先を決める。http/https/mailto/tel はそのまま、intent: は browser_fallback_url(http(s))があればそれ、
 * それ以外(javascript: 等)は null(開けない)。
 */
export function externalOpenTarget(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  const p = url.protocol;
  if (p === "http:" || p === "https:" || p === "mailto:" || p === "tel:") return input;
  if (p === "intent:") {
    const m = /;S\.browser_fallback_url=([^;]+)/.exec(input);
    if (!m) return null;
    try {
      const fb = decodeURIComponent(m[1]);
      return /^https?:\/\//i.test(fb) ? fb : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** 確認ダイアログ表示用に URL を切り詰める。 */
export function truncateUrl(url: string, max = 100): string {
  return url.length > max ? url.slice(0, max - 1) + "…" : url;
}
