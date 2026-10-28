/** 対応 3 サイトの URL 解決(純粋関数のみ。サイトへのアクセスは行わない)。 */
export type SiteId = "hameln" | "narou" | "kakuyomu";

export const SITE_IDS: SiteId[] = ["hameln", "narou", "kakuyomu"];

export interface ResolvedUrl {
  site: SiteId;
  novelKey: string;
  episodeKey?: string;
}

export function isSiteId(v: string): v is SiteId {
  return (SITE_IDS as string[]).includes(v);
}

const NAROU_HOST = "ncode.syosetu.com";
const HAMELN_HOST = "syosetu.org";
const KAKUYOMU_HOST = "kakuyomu.jp";

/** 作品ページ URL を組み立てる。 */
export function novelUrl(site: SiteId, novelKey: string): string {
  switch (site) {
    case "narou":
      return `https://${NAROU_HOST}/${novelKey.toLowerCase()}/`;
    case "hameln":
      return `https://${HAMELN_HOST}/novel/${novelKey}/`;
    case "kakuyomu":
      return `https://${KAKUYOMU_HOST}/works/${novelKey}`;
  }
}

type Parsed = { novelKey: string; episodeKey?: string };

function parseNarou(url: URL): Parsed | null {
  if (url.hostname.toLowerCase() !== NAROU_HOST) return null;
  const m = /^\/(n\d{4}[a-z]{1,2})(?:\/(\d+))?\/?$/i.exec(url.pathname);
  return m ? { novelKey: m[1]!.toLowerCase(), episodeKey: m[2] } : null;
}

function parseHameln(url: URL): Parsed | null {
  const host = url.hostname.toLowerCase();
  if (host !== HAMELN_HOST && host !== `www.${HAMELN_HOST}`) return null;
  const m = /^\/novel\/(\d+)(?:\/(?:(\d+)\.html)?)?$/.exec(url.pathname);
  if (m) return { novelKey: m[1]!, episodeKey: m[2] };
  // 旧形式 /?mode=ss_detail&nid=123
  const nid = url.searchParams.get("nid");
  if (url.searchParams.get("mode") === "ss_detail" && nid && /^\d+$/.test(nid)) return { novelKey: nid };
  return null;
}

function parseKakuyomu(url: URL): Parsed | null {
  if (url.hostname.toLowerCase() !== KAKUYOMU_HOST) return null;
  const m = /^\/works\/(\d+)(?:\/episodes\/(\d+))?\/?$/.exec(url.pathname);
  return m ? { novelKey: m[1]!, episodeKey: m[2] } : null;
}

const PARSERS: Record<SiteId, (u: URL) => Parsed | null> = {
  hameln: parseHameln,
  narou: parseNarou,
  kakuyomu: parseKakuyomu,
};

/** 元サイト URL から作品/話を解決する。作品/話ページでなければ null。 */
export function resolveUrl(input: string): ResolvedUrl | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  for (const site of SITE_IDS) {
    const parsed = PARSERS[site](url);
    if (parsed) return { site, ...parsed };
  }
  return null;
}
