import { hamelnAdapter } from "./hameln.js";
import { kakuyomuAdapter } from "./kakuyomu.js";
import { narouAdapter } from "./narou.js";
import type { SiteAdapter, SiteId } from "./types.js";

export * from "./types.js";
export { sanitizeBody, htmlToText } from "./sanitize.js";

const adapters: Record<SiteId, SiteAdapter> = {
  hameln: hamelnAdapter,
  narou: narouAdapter,
  kakuyomu: kakuyomuAdapter,
};

export const SITE_IDS = Object.keys(adapters) as SiteId[];

export function isSiteId(v: string): v is SiteId {
  return Object.prototype.hasOwnProperty.call(adapters, v);
}

export function getAdapter(site: SiteId): SiteAdapter {
  return adapters[site];
}

export function listAdapters(): SiteAdapter[] {
  return SITE_IDS.map((s) => adapters[s]);
}

export interface ResolvedUrl {
  site: SiteId;
  novelKey: string;
  episodeKey?: string;
}

function normHost(h: string): string {
  return h.toLowerCase().replace(/^www\./, "");
}

/** そのサイトの Proxy 許可ホストか */
export function isAllowedHost(site: SiteId, host: string): boolean {
  const n = normHost(host);
  return adapters[site].hosts.some((h) => normHost(h) === n);
}

/** ホスト名からサイトを判定(許可ホスト一致のみ) */
export function siteForHost(host: string): SiteId | null {
  return SITE_IDS.find((s) => isAllowedHost(s, host)) ?? null;
}

/**
 * 元サイト URL または `/proxy/{site}/{host}/{path}?{query}` 形式のパス/URL から作品/話を解決する。
 * 作品/話ページでなければ null。
 */
export function resolveUrl(input: string | URL): ResolvedUrl | null {
  let url: URL;
  try {
    url = typeof input === "string" ? new URL(input, "http://localhost") : input;
  } catch {
    return null;
  }
  if (url.pathname.startsWith("/proxy/")) {
    const m = /^\/proxy\/([^/]+)\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (!m) return null;
    const [, site, host, rest] = m;
    if (!isSiteId(site!) || !isAllowedHost(site, host!)) return null;
    let target: URL;
    try {
      target = new URL(`https://${host}${rest ?? "/"}${url.search}`);
    } catch {
      return null;
    }
    const parsed = adapters[site].parseUrl(target);
    return parsed ? { site, ...parsed } : null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.hostname === "localhost") return null;
  for (const site of SITE_IDS) {
    if (!isAllowedHost(site, url.hostname)) continue;
    const parsed = adapters[site].parseUrl(url);
    if (parsed) return { site, ...parsed };
  }
  return null;
}
