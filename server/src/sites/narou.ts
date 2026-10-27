import * as cheerio from "cheerio";
import { politeFetch } from "../http/politeFetch.js";
import { isBlankHtml, sanitizeBody } from "./sanitize.js";
import {
  SHORT_EPISODE_KEY,
  SiteNotFoundError,
  SiteParseError,
  type EpisodeContent,
  type FetchOptions,
  type NovelInfo,
  type NovelMeta,
  type SiteAdapter,
  type TocEntry,
} from "./types.js";
import { assertNotBlocked, parseJstDate } from "./util.js";

// ---- セレクタ定数(DOM 変更に備え、複数候補をフォールバックで持つ。2026-10 に実ページで確認) ----
export const NAROU_SELECTORS = {
  // 目次 (新レイアウト)
  tocRoot: [".p-eplist"],
  chapterTitle: [".p-eplist__chapter-title"],
  subItem: [".p-eplist__sublist"],
  subLink: [".p-eplist__subtitle"],
  subUpdate: [".p-eplist__update"],
  pagerLast: [".c-pager__item--last"],
  pagerLinks: [".c-pager a[href*='?p=']"],
  // 目次 (旧レイアウト)
  legacyRoot: [".index_box"],
  legacyChapter: [".chapter_title"],
  legacyItem: [".novel_sublist2"],
  legacyLink: [".subtitle a"],
  legacyUpdate: [".long_update"],
  // 本文 (新レイアウト)
  title: [".p-novel__title"],
  textBlocks: [".p-novel__body .js-novel-text", ".p-novel__text"],
  preface: [".p-novel__text--preface"],
  afterword: [".p-novel__text--afterword"],
  // 本文 (旧レイアウト)
  legacyTitle: [".novel_subtitle", "h1.novel_title"],
  legacyPreface: ["#novel_p"],
  legacyBody: ["#novel_honbun"],
  legacyAfterword: ["#novel_a"],
} as const;

const HOST = "ncode.syosetu.com";
const API_URL = "https://api.syosetu.com/novelapi/api/";

type Sel = readonly string[];

/** セレクタ候補を順に試し、最初にヒットしたものを返す。 */
function pick($: cheerio.CheerioAPI, selectors: Sel, scope?: ReturnType<cheerio.CheerioAPI>) {
  for (const s of selectors) {
    const el = scope ? scope.find(s) : $(s);
    if (el.length) return el;
  }
  return $([]);
}

export function narouNovelUrl(ncode: string): string {
  return `https://${HOST}/${ncode.toLowerCase()}/`;
}

export function narouEpisodeUrl(ncode: string, episodeKey: string): string {
  return episodeKey === SHORT_EPISODE_KEY ? narouNovelUrl(ncode) : `https://${HOST}/${ncode.toLowerCase()}/${episodeKey}/`;
}

// ---- API メタ ----
export interface NarouApiMeta {
  title: string;
  ncode: string;
  userid?: number;
  writer: string;
  story: string;
  keyword: string;
  isShort: boolean;
  /** end=0 は完結済(または短編)、1 は連載中 */
  ended: boolean;
  episodeCount: number;
  firstUp?: string;
  lastUp?: string;
  novelUpdatedAt?: string;
}

/** 公式 API のレスポンス JSON → メタ。該当作品なしは SiteNotFoundError。 */
export function parseNarouApi(json: unknown): NarouApiMeta {
  // 外部 JSON 境界
  const arr = json as Array<Record<string, any>>;
  if (!Array.isArray(arr) || arr.length < 2 || !arr[0] || !arr[0].allcount) {
    throw new SiteNotFoundError("narou api: no such novel");
  }
  const n = arr[1]!;
  return {
    title: String(n.title ?? ""),
    ncode: String(n.ncode ?? "").toLowerCase(),
    userid: typeof n.userid === "number" ? n.userid : undefined,
    writer: String(n.writer ?? ""),
    story: String(n.story ?? ""),
    keyword: String(n.keyword ?? ""),
    isShort: Number(n.novel_type ?? n.noveltype) === 2,
    ended: Number(n.end) === 0,
    episodeCount: Number(n.general_all_no ?? 0),
    firstUp: parseJstDate(n.general_firstup),
    lastUp: parseJstDate(n.general_lastup),
    novelUpdatedAt: parseJstDate(n.novelupdated_at),
  };
}

export function narouMetaFromApi(api: NarouApiMeta, ncode: string): NovelMeta {
  return {
    site: "narou",
    novelKey: ncode.toLowerCase(),
    url: narouNovelUrl(ncode),
    title: api.title,
    author: api.writer,
    authorUrl: api.userid ? `https://mypage.syosetu.com/${api.userid}/` : undefined,
    synopsis: api.story.replace(/\r\n?/g, "\n").trim(),
    tags: api.keyword.split(/\s+/).filter(Boolean),
    status: api.isShort || api.ended ? "completed" : "ongoing",
    isShortStory: api.isShort,
  };
}

// ---- 目次 ----
export interface NarouTocPage {
  entries: Omit<TocEntry, "index">[];
  /** 全ページ数(ページャが無ければ 1) */
  lastPage: number;
  /** このページ末尾時点の章タイトル(次ページへ引き継ぐ) */
  lastChapter?: string;
}

function episodeKeyFromHref(href: string | undefined): string | undefined {
  if (!href) return undefined;
  const m = /\/n\d{4}[a-z]{1,2}\/(\d+)\/?(?:[?#].*)?$/i.exec(href);
  return m?.[1];
}

/** 目次 1 ページ分の HTML → エントリ。chapter は前ページ末尾の章を引き継ぐ。 */
export function parseNarouTocPage(html: string, carryChapter?: string): NarouTocPage {
  const $ = cheerio.load(html);
  const S = NAROU_SELECTORS;
  const entries: NarouTocPage["entries"] = [];
  let chapter = carryChapter;

  const readItem = (node: ReturnType<cheerio.CheerioAPI>, link: Sel, update: Sel) => {
    const a = pick($, link, node).first();
    const key = episodeKeyFromHref(a.attr("href"));
    if (!key) return;
    const upd = pick($, update, node).first();
    const published = parseJstDate(upd.clone().children().remove().end().text());
    const revised = parseJstDate(upd.find("[title]").first().attr("title"));
    entries.push({
      episodeKey: key,
      title: a.text().trim(),
      chapter,
      publishedAt: published,
      updatedAt: revised ?? published,
    });
  };

  const layouts = [
    { root: S.tocRoot, chapter: S.chapterTitle, item: S.subItem, link: S.subLink, update: S.subUpdate },
    { root: S.legacyRoot, chapter: S.legacyChapter, item: S.legacyItem, link: S.legacyLink, update: S.legacyUpdate },
  ];
  for (const L of layouts) {
    const root = pick($, L.root);
    if (!root.length) continue;
    root.first().children().each((_, el) => {
      const node = $(el);
      if (node.is(L.chapter.join(","))) chapter = node.text().trim() || undefined;
      else if (node.is(L.item.join(","))) readItem(node, L.link, L.update);
    });
    if (entries.length) break;
  }

  let lastPage = 1;
  const scan = (href: string | undefined) => {
    const m = /[?&]p=(\d+)/.exec(href ?? "");
    if (m) lastPage = Math.max(lastPage, Number(m[1]));
  };
  for (const sel of S.pagerLast) scan($(sel).first().attr("href"));
  for (const sel of S.pagerLinks) $(sel).each((_, a) => scan($(a).attr("href")));
  return { entries, lastPage, lastChapter: chapter };
}

// ---- 本文 ----
export function parseNarouEpisode(html: string, episodeKey: string, baseUrl: string): EpisodeContent {
  const $ = cheerio.load(html);
  const S = NAROU_SELECTORS;
  const title = (pick($, S.title).first().text() || pick($, S.legacyTitle).first().text()).trim();

  let preface: string | undefined;
  let afterword: string | undefined;
  let body: string | undefined;

  const blocks = pick($, S.textBlocks);
  if (blocks.length) {
    blocks.each((_, el) => {
      const node = $(el);
      if (node.is(S.preface.join(",")) || node.is(S.afterword.join(","))) return;
      if (body === undefined) body = node.html() ?? "";
    });
    preface = pick($, S.preface).first().html() ?? undefined;
    afterword = pick($, S.afterword).first().html() ?? undefined;
  } else {
    const lb = pick($, S.legacyBody).first();
    if (lb.length) {
      body = lb.html() ?? "";
      preface = pick($, S.legacyPreface).first().html() ?? undefined;
      afterword = pick($, S.legacyAfterword).first().html() ?? undefined;
    }
  }
  if (body === undefined) throw new SiteParseError("narou: episode body not found");
  const clean = (h: string | undefined) => {
    const s = h === undefined ? undefined : sanitizeBody(h, baseUrl);
    return isBlankHtml(s) ? undefined : s;
  };
  return {
    episodeKey,
    title,
    prefaceHtml: clean(preface),
    bodyHtml: sanitizeBody(body, baseUrl),
    afterwordHtml: clean(afterword),
  };
}

// ---- Adapter ----
async function fetchApi(ncode: string, opts?: FetchOptions): Promise<NarouApiMeta> {
  const r = await politeFetch(`${API_URL}?out=json&ncode=${encodeURIComponent(ncode)}`, { priority: opts?.priority });
  let json: unknown;
  try {
    json = JSON.parse(r.text);
  } catch {
    throw new SiteParseError("narou api: invalid JSON");
  }
  return parseNarouApi(json);
}

export const narouAdapter: SiteAdapter = {
  site: "narou",
  displayName: "小説家になろう",
  hosts: [HOST, "yomou.syosetu.com", "syosetu.com"],
  parseUrl(url) {
    if (url.hostname.toLowerCase() !== HOST) return null;
    const m = /^\/(n\d{4}[a-z]{1,2})(?:\/(\d+))?\/?$/i.exec(url.pathname);
    if (!m) return null;
    return { novelKey: m[1]!.toLowerCase(), episodeKey: m[2] };
  },
  novelUrl: narouNovelUrl,
  episodeUrl: narouEpisodeUrl,

  async fetchNovel(novelKey, opts) {
    const ncode = novelKey.toLowerCase();
    const api = await fetchApi(ncode, opts);
    const meta = narouMetaFromApi(api, ncode);
    if (api.isShort) {
      return {
        ...meta,
        episodes: [
          {
            episodeKey: SHORT_EPISODE_KEY,
            index: 0,
            title: meta.title,
            publishedAt: api.firstUp,
            updatedAt: api.novelUpdatedAt ?? api.lastUp ?? api.firstUp,
          },
        ],
      } satisfies NovelInfo;
    }
    const episodes: TocEntry[] = [];
    const seen = new Set<string>();
    let chapter: string | undefined;
    let lastPage = 1;
    for (let page = 1; page <= lastPage; page++) {
      const url = page === 1 ? narouNovelUrl(ncode) : `${narouNovelUrl(ncode)}?p=${page}`;
      const r = await politeFetch(url, { priority: opts?.priority });
      assertNotBlocked(r.text);
      const parsed = parseNarouTocPage(r.text, chapter);
      chapter = parsed.lastChapter;
      if (page === 1) lastPage = parsed.lastPage;
      for (const e of parsed.entries) {
        if (seen.has(e.episodeKey)) continue;
        seen.add(e.episodeKey);
        episodes.push({ ...e, index: episodes.length });
      }
    }
    return { ...meta, episodes };
  },

  async fetchEpisode(novelKey, episodeKey, opts) {
    const url = narouEpisodeUrl(novelKey, episodeKey);
    const r = await politeFetch(url, { priority: opts?.priority });
    assertNotBlocked(r.text);
    return parseNarouEpisode(r.text, episodeKey, url);
  },
};
