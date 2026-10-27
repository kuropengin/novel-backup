export type SiteId = "hameln" | "narou" | "kakuyomu";

export interface TocEntry {
  episodeKey: string; // サイト上の話ID
  index: number; // 0 始まりの並び順
  title: string;
  chapter?: string; // 所属する章タイトル(あれば)
  publishedAt?: string; // ISO8601 (UTC)
  updatedAt?: string; // ISO8601 (UTC)。改稿日。無ければ publishedAt
}

export interface NovelMeta {
  site: SiteId;
  novelKey: string;
  url: string;
  title: string;
  author: string;
  authorUrl?: string;
  synopsis: string; // プレーンテキスト(改行保持)
  tags: string[];
  status: "ongoing" | "completed" | "unknown";
  isShortStory: boolean; // 短編(目次なし1話)
}

export interface NovelInfo extends NovelMeta {
  episodes: TocEntry[];
}

export interface EpisodeContent {
  episodeKey: string;
  title: string;
  prefaceHtml?: string; // 前書き(サニタイズ済み)
  bodyHtml: string; // 本文(サニタイズ済み)
  afterwordHtml?: string; // 後書き(サニタイズ済み)
}

export interface FetchOptions {
  /** ライブ閲覧(ユーザー操作)は 'interactive'。既定 'normal'(バックアップ等) */
  priority?: "normal" | "interactive";
}

export interface ParsedSiteUrl {
  novelKey: string;
  episodeKey?: string;
}

export interface SiteAdapter {
  site: SiteId;
  displayName: string;
  /** Proxy 許可ホスト。先頭が既定ホスト */
  hosts: string[];
  /** 元サイト URL を解析。作品/話ページでなければ null */
  parseUrl(url: URL): ParsedSiteUrl | null;
  novelUrl(novelKey: string): string;
  episodeUrl(novelKey: string, episodeKey: string): string;
  fetchNovel(novelKey: string, opts?: FetchOptions): Promise<NovelInfo>;
  fetchEpisode(novelKey: string, episodeKey: string, opts?: FetchOptions): Promise<EpisodeContent>;
}

/** 短編の episodeKey (hameln / narou) */
export const SHORT_EPISODE_KEY = "short";

/** 作品/話が存在しない(404/410 等) */
export class SiteNotFoundError extends Error {
  constructor(message = "not found") {
    super(message);
    this.name = "SiteNotFoundError";
  }
}

/** Cloudflare チャレンジ・年齢確認などで HTML が取得できない */
export class SiteBlockedError extends Error {
  constructor(
    message: string,
    public readonly reason: "challenge" | "age-gate" | "other" = "other",
  ) {
    super(message);
    this.name = "SiteBlockedError";
  }
}

/** DOM 変更等で期待した構造が見つからない */
export class SiteParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SiteParseError";
  }
}
