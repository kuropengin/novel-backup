import * as cheerio from "cheerio";
import { politeFetch } from "../http/politeFetch.js";
import { sanitizeBody } from "./sanitize.js";
import {
  SiteNotFoundError,
  SiteParseError,
  type EpisodeContent,
  type NovelInfo,
  type SiteAdapter,
  type TocEntry,
} from "./types.js";
import { assertNotBlocked } from "./util.js";

// ---- セレクタ/キー定数(2026-10 に実ページで確認) ----
export const KAKUYOMU_SELECTORS = {
  nextData: ["script#__NEXT_DATA__"],
  episodeTitle: [".widget-episodeTitle", "[class*='widget-episodeTitle']", "h1"],
  episodeBody: [".widget-episodeBody", "[class*='widget-episodeBody']", ".js-episode-body"],
} as const;

/** Apollo State 内の Work が持つ目次フィールド(新旧フォールバック) */
const TOC_FIELDS = ["tableOfContentsV2", "tableOfContents"] as const;

const HOST = "kakuyomu.jp";

type Ref = { __ref: string };
// Apollo キャッシュ(外部 JSON 境界)
type ApolloState = Record<string, Record<string, any> | undefined>;

export function kakuyomuNovelUrl(workId: string): string {
  return `https://${HOST}/works/${workId}`;
}
export function kakuyomuEpisodeUrl(workId: string, episodeId: string): string {
  return `https://${HOST}/works/${workId}/episodes/${episodeId}`;
}

function isoOrUndefined(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

export function extractApolloState(html: string): ApolloState {
  const $ = cheerio.load(html);
  let raw: string | undefined;
  for (const s of KAKUYOMU_SELECTORS.nextData) {
    const t = $(s).first().html();
    if (t) {
      raw = t;
      break;
    }
  }
  if (!raw) throw new SiteParseError("kakuyomu: __NEXT_DATA__ not found");
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new SiteParseError("kakuyomu: __NEXT_DATA__ is not valid JSON");
  }
  const st = data?.props?.pageProps?.__APOLLO_STATE__;
  if (!st || typeof st !== "object") throw new SiteParseError("kakuyomu: __APOLLO_STATE__ not found");
  return st as ApolloState;
}

/** 作品ページ HTML → NovelInfo (純関数) */
export function parseKakuyomuWork(html: string, workId: string): NovelInfo {
  const st = extractApolloState(html);
  const work = st[`Work:${workId}`];
  if (!work) throw new SiteNotFoundError(`kakuyomu: Work:${workId} not in page state`);

  const author = work.author?.__ref ? st[(work.author as Ref).__ref] : undefined;
  const authorId: string | undefined = author?.name;
  const authorName = String(work.alternateAuthorName ?? author?.activityName ?? author?.name ?? "");

  const episodes: TocEntry[] = [];
  let level1: string | undefined;
  const tocField = TOC_FIELDS.find((f) => Array.isArray(work[f]));
  const chapters: Ref[] = tocField ? (work[tocField] as Ref[]) : [];
  for (const cref of chapters) {
    const toc = st[cref.__ref];
    if (!toc) continue;
    let chapterLabel: string | undefined;
    const ch = toc.chapter?.__ref ? st[(toc.chapter as Ref).__ref] : undefined;
    if (ch) {
      const title = String(ch.title ?? "");
      if (Number(ch.level) <= 1) {
        level1 = title;
        chapterLabel = title;
      } else {
        chapterLabel = level1 ? `${level1} / ${title}` : title;
      }
    } else {
      level1 = undefined;
    }
    for (const eref of (toc.episodeUnions ?? []) as Ref[]) {
      if (!eref.__ref?.startsWith("Episode:")) continue;
      const ep = st[eref.__ref];
      if (!ep) continue;
      const published = isoOrUndefined(ep.publishedAt);
      episodes.push({
        episodeKey: String(ep.id ?? eref.__ref.slice("Episode:".length)),
        index: episodes.length,
        title: String(ep.title ?? ""),
        chapter: chapterLabel,
        publishedAt: published,
        updatedAt: published,
      });
    }
  }

  const status = work.serialStatus === "COMPLETED" ? "completed" : work.serialStatus === "RUNNING" ? "ongoing" : "unknown";
  return {
    site: "kakuyomu",
    novelKey: workId,
    url: kakuyomuNovelUrl(workId),
    title: String(work.title ?? ""),
    author: authorName,
    authorUrl: authorId ? `https://${HOST}/users/${authorId}` : undefined,
    synopsis: String(work.introduction ?? "").replace(/\r\n?/g, "\n").trim(),
    tags: Array.isArray(work.tagLabels) ? work.tagLabels.map(String) : [],
    status,
    // カクヨムに短編専用ページは無く、1 話の作品も通常の話 URL を持つ
    isShortStory: false,
    episodes,
  };
}

/** 話ページ HTML → EpisodeContent (純関数) */
export function parseKakuyomuEpisode(html: string, episodeKey: string, baseUrl: string): EpisodeContent {
  const $ = cheerio.load(html);
  let title = "";
  for (const s of KAKUYOMU_SELECTORS.episodeTitle) {
    title = $(s).first().text().trim();
    if (title) break;
  }
  let body: string | undefined;
  for (const s of KAKUYOMU_SELECTORS.episodeBody) {
    const el = $(s).first();
    if (el.length) {
      body = el.html() ?? "";
      break;
    }
  }
  if (body === undefined) throw new SiteParseError("kakuyomu: episode body not found");
  return { episodeKey, title, bodyHtml: sanitizeBody(body, baseUrl) };
}

export const kakuyomuAdapter: SiteAdapter = {
  site: "kakuyomu",
  displayName: "カクヨム",
  hosts: [HOST],
  parseUrl(url) {
    if (url.hostname.toLowerCase() !== HOST) return null;
    const m = /^\/works\/(\d+)(?:\/episodes\/(\d+))?\/?$/.exec(url.pathname);
    if (!m) return null;
    return { novelKey: m[1]!, episodeKey: m[2] };
  },
  novelUrl: kakuyomuNovelUrl,
  episodeUrl: kakuyomuEpisodeUrl,

  async fetchNovel(novelKey, opts) {
    const r = await politeFetch(kakuyomuNovelUrl(novelKey), { priority: opts?.priority });
    assertNotBlocked(r.text);
    return parseKakuyomuWork(r.text, novelKey);
  },

  async fetchEpisode(novelKey, episodeKey, opts) {
    const url = kakuyomuEpisodeUrl(novelKey, episodeKey);
    const r = await politeFetch(url, { priority: opts?.priority });
    assertNotBlocked(r.text);
    return parseKakuyomuEpisode(r.text, episodeKey, url);
  },
};
