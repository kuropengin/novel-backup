import * as cheerio from "cheerio";
import { politeFetch } from "../http/politeFetch.js";
import { elementToText, isBlankHtml, sanitizeBody } from "./sanitize.js";
import {
  SHORT_EPISODE_KEY,
  SiteBlockedError,
  SiteParseError,
  type EpisodeContent,
  type NovelInfo,
  type SiteAdapter,
  type TocEntry,
} from "./types.js";
import { assertNotBlocked, parseJstDate } from "./util.js";

/**
 * 注意: 開発環境からは Cloudflare チャレンジ(403 / cf-mitigated: challenge)で実ページを取得できなかったため、
 * 以下のセレクタは既知の DOM(docs/04 と過去の構造)に基づくもので、実ページでは未検証。
 * 取得できる環境で `npx tsx server/scripts/try-adapter.ts https://syosetu.org/novel/<id>/` により確認すること。
 * 複数候補のフォールバックを持たせてある。
 */
export const HAMELN_SELECTORS = {
  title: ['span[itemprop="name"]', ".ss span[style*='font-size:120%']", ".ss span[style*='font-size']"],
  author: ['span[itemprop="author"] a', 'span[itemprop="author"]', ".ss a[href*='/user/']"],
  /** 作品情報ブロック(あらすじ・タグ・状態を含む) */
  infoBlocks: ["div.ss"],
  tagLinks: ["a[href*='word=']", "a[href*='mode=search']"],
  /** 目次行。話リンクは `1.html` 形式 */
  tocRow: ["tr"],
  tocChapter: ["td[colspan] strong", "td[colspan]", "strong"],
  episodeLink: ["a[href$='.html']"],
  honbun: ["#honbun"],
  maegaki: ["#maegaki"],
  atogaki: ["#atogaki"],
  episodeTitle: [".ss span[style*='font-size:120%']", ".ss span[style*='font-size']", "h1"],
} as const;

const HOST = "syosetu.org";

type Sel = readonly string[];

function pick($: cheerio.CheerioAPI, selectors: Sel, scope?: ReturnType<cheerio.CheerioAPI>) {
  for (const s of selectors) {
    const el = scope ? scope.find(s) : $(s);
    if (el.length) return el;
  }
  return $([]);
}

export function hamelnNovelUrl(id: string): string {
  return `https://${HOST}/novel/${id}/`;
}
export function hamelnEpisodeUrl(id: string, episodeKey: string): string {
  return episodeKey === SHORT_EPISODE_KEY ? hamelnNovelUrl(id) : `https://${HOST}/novel/${id}/${episodeKey}.html`;
}

/** 年齢確認ページ等(本文も目次も無い)の検出 */
function assertNotAgeGate(html: string, $: cheerio.CheerioAPI): void {
  const hasContent = $("#honbun").length > 0 || $("a[href$='.html']").length > 0;
  if (!hasContent && /18歳|年齢確認|アダルト/.test($("body").text())) {
    throw new SiteBlockedError("hameln: age confirmation page", "age-gate");
  }
}

/** 作品ページ(目次 or 短編本文)HTML → NovelInfo (純関数) */
export function parseHamelnNovelPage(html: string, novelKey: string): NovelInfo {
  assertNotBlocked(html);
  const $ = cheerio.load(html);
  assertNotAgeGate(html, $);
  const S = HAMELN_SELECTORS;

  let title = pick($, S.title).first().text().trim();
  if (!title) title = $("title").first().text().replace(/\s*[-－|]\s*ハーメルン.*$/, "").trim();
  if (!title) throw new SiteParseError("hameln: title not found");

  const authorEl = pick($, S.author).first();
  const author = authorEl.text().trim();
  const authorHref = (authorEl.is("a") ? authorEl : authorEl.find("a").first()).attr("href");
  const authorUrl = authorHref ? new URL(authorHref, hamelnNovelUrl(novelKey)).toString() : undefined;

  // あらすじ: タイトル/作者を含まない最初の .ss(タグ・目次リンクを含まないもの)
  let synopsis = "";
  let statusText = "";
  pick($, S.infoBlocks).each((i, el) => {
    const b = $(el);
    if (i === 0) statusText = b.text();
    if (synopsis) return;
    if (pick($, S.title, b).length || pick($, S.author, b).length) return;
    if (pick($, S.tagLinks, b).length) return;
    const t = elementToText($, b);
    if (t) synopsis = t;
  });

  const tags: string[] = [];
  const infoBlocks = pick($, S.infoBlocks);
  for (const sel of S.tagLinks) {
    infoBlocks.find(sel).each((_, a) => {
      const t = $(a).text().trim();
      if (t && !tags.includes(t)) tags.push(t);
    });
    if (tags.length) break;
  }

  const status: NovelInfo["status"] = /完結/.test(statusText) ? "completed" : /連載中/.test(statusText) ? "ongoing" : "unknown";

  // 目次
  const episodes: TocEntry[] = [];
  let chapter: string | undefined;
  $(S.tocRow[0]).each((_, tr) => {
    const row = $(tr);
    // 話リンク(相対 `N.html`)
    const a = row.find("a").filter((_, x) => /(^|\/)\d+\.html$/.test($(x).attr("href") ?? "")).first();
    if (a.length) {
      const key = /(\d+)\.html$/.exec(a.attr("href") ?? "")![1]!;
      let revised: string | undefined;
      row.find("[title]").each((_, t) => {
        const d = parseJstDate($(t).attr("title"));
        if (d) revised = d;
      });
      const pub = parseJstDate(row.text());
      episodes.push({
        episodeKey: key,
        index: episodes.length,
        title: a.text().trim(),
        chapter,
        publishedAt: pub,
        updatedAt: revised ?? pub,
      });
      return;
    }
    // 章見出し行
    const ch = row.find("td[colspan]").first();
    if (ch.length && !ch.find("a").length) {
      const t = (pick($, S.tocChapter, row).first().text() || ch.text()).trim();
      if (t) chapter = t;
    }
  });

  const honbun = pick($, S.honbun).first();
  const isShort = episodes.length === 0 && honbun.length > 0;
  if (!isShort && episodes.length === 0) throw new SiteParseError("hameln: no episodes or body found");

  if (isShort) {
    const published = parseJstDate(statusText) ?? undefined;
    episodes.push({ episodeKey: SHORT_EPISODE_KEY, index: 0, title, publishedAt: published, updatedAt: published });
  }

  return {
    site: "hameln",
    novelKey,
    url: hamelnNovelUrl(novelKey),
    title,
    author,
    authorUrl,
    synopsis,
    tags,
    status: isShort && status === "unknown" ? "completed" : status,
    isShortStory: isShort,
    episodes,
  };
}

/** 話ページ(または短編の作品ページ)HTML → EpisodeContent (純関数) */
export function parseHamelnEpisode(html: string, episodeKey: string, baseUrl: string): EpisodeContent {
  assertNotBlocked(html);
  const $ = cheerio.load(html);
  assertNotAgeGate(html, $);
  const S = HAMELN_SELECTORS;
  const honbun = pick($, S.honbun).first();
  if (!honbun.length) throw new SiteParseError("hameln: #honbun not found");
  const clean = (el: ReturnType<cheerio.CheerioAPI>) => {
    if (!el.length) return undefined;
    const s = sanitizeBody(el.html() ?? "", baseUrl);
    return isBlankHtml(s) ? undefined : s;
  };
  const title = pick($, S.episodeTitle).first().text().trim();
  return {
    episodeKey,
    title,
    prefaceHtml: clean(pick($, S.maegaki).first()),
    bodyHtml: sanitizeBody(honbun.html() ?? "", baseUrl),
    afterwordHtml: clean(pick($, S.atogaki).first()),
  };
}

export const hamelnAdapter: SiteAdapter = {
  site: "hameln",
  displayName: "ハーメルン",
  hosts: [HOST],
  parseUrl(url) {
    const host = url.hostname.toLowerCase();
    if (host !== HOST && host !== `www.${HOST}`) return null;
    const m = /^\/novel\/(\d+)(?:\/(?:(\d+)\.html)?)?$/.exec(url.pathname);
    if (m) return { novelKey: m[1]!, episodeKey: m[2] };
    // 旧形式 /?mode=ss_detail&nid=123
    const nid = url.searchParams.get("nid");
    if (url.searchParams.get("mode") === "ss_detail" && nid && /^\d+$/.test(nid)) return { novelKey: nid };
    return null;
  },
  novelUrl: hamelnNovelUrl,
  episodeUrl: hamelnEpisodeUrl,

  async fetchNovel(novelKey, opts) {
    const r = await politeFetch(hamelnNovelUrl(novelKey), { priority: opts?.priority });
    return parseHamelnNovelPage(r.text, novelKey);
  },

  async fetchEpisode(novelKey, episodeKey, opts) {
    const url = hamelnEpisodeUrl(novelKey, episodeKey);
    const r = await politeFetch(url, { priority: opts?.priority });
    return parseHamelnEpisode(r.text, episodeKey, url);
  },
};
