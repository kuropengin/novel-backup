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
