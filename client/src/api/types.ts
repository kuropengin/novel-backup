export type Role = "admin" | "viewer";

export interface User {
  id: number;
  username: string;
  role: Role;
}

export interface UserDetail extends User {
  createdAt: string;
}

export interface AuthStatus {
  setupRequired: boolean;
  user: User | null;
}

export interface Settings {
  backupIntervalMinutes: number;
  backupStartAt: string | null;
  requestIntervalMs: number;
  fullRecheckEveryRuns: number;
  maxEpisodesPerNovelPerRun: number;
  hamelnUserAgent: string;
  hamelnCookieSet: boolean;
  hamelnCookieNames: string[];
}

export type SiteId = "hameln" | "narou" | "kakuyomu";

export interface SiteInfo {
  site: SiteId;
  displayName: string;
  hosts: string[];
  defaultHost: string;
}

export interface TocEntry {
  episodeKey: string;
  index: number;
  title: string;
  chapter?: string;
  publishedAt?: string;
  updatedAt?: string;
}

export interface NovelInfo {
  site: SiteId;
  novelKey: string;
  url: string;
  title: string;
  author: string;
  authorUrl?: string;
  synopsis: string;
  tags: string[];
  status: "ongoing" | "completed" | "unknown";
  isShortStory: boolean;
  episodes: TocEntry[];
  bookmarked: boolean;
  bookmarkId: number | null;
}

export interface LiveEpisode {
  episodeKey: string;
  title: string;
  prefaceHtml?: string;
  bodyHtml: string;
  afterwordHtml?: string;
  site: SiteId;
  novelKey: string;
  novelTitle: string;
  chapter: string | null;
  index: number;
  total: number;
  url: string;
  prevEpisodeKey: string | null;
  nextEpisodeKey: string | null;
  bookmarked: boolean;
  bookmarkId: number | null;
}

export interface ResolvedUrl {
  site: SiteId;
  novelKey: string;
  episodeKey?: string;
  bookmarked: boolean;
  bookmarkId: number | null;
}

export interface Bookmark {
  id: number;
  novelId: number;
  site: SiteId;
  novelKey: string;
  title: string;
  author: string;
  url: string;
  siteStatus: string;
  isDeletedOnSite: boolean;
  note: string;
  lastReadEpisodeKey: string | null;
  createdAt: string;
  lastBackupAt: string | null;
  lastChangedAt: string | null;
  lastError: string | null;
  episodeCount: number;
  unreadCount: number;
}

// ---- backups ----
export interface BackupNovel {
  id: number;
  site: SiteId;
  novelKey: string;
  title: string;
  author: string;
  url: string;
  siteStatus: string;
  isDeletedOnSite: boolean;
  createdAt: string;
  lastCheckedAt: string | null;
  lastChangedAt: string | null;
  lastError: string | null;
  episodeCount: number;
  removedCount: number;
  unfetchedCount: number;
  versionCount: number;
  bookmarked: boolean;
  queued: boolean;
}

export interface BackupMeta {
  title: string;
  author: string;
  authorUrl: string | null;
  synopsis: string;
  tags: string[];
  status: string;
  isShortStory: boolean;
  url: string;
}

export interface BackupMetaVersion {
  version: number;
  hash: string;
  fetchedAt: string;
  tocCount: number;
  meta: BackupMeta | null;
}

export interface BackupEpisodeSummary {
  id: number;
  episodeKey: string;
  position: number;
  title: string;
  chapter: string | null;
  publishedAt: string | null;
  siteUpdatedAt: string | null;
  removedAt: string | null;
  versionCount: number;
  lastFetchedAt: string | null;
}

export interface BackupNovelDetail {
  novel: BackupNovel;
  meta: BackupMeta | null;
  metaVersions: BackupMetaVersion[];
  episodes: BackupEpisodeSummary[];
}

export interface EpisodeVersionSummary {
  version: number;
  fetchedAt: string;
  siteUpdatedAt: string | null;
  contentHash: string;
}

export interface EpisodeVersionBody extends EpisodeVersionSummary {
  title: string;
  prefaceHtml: string | null;
  bodyHtml: string;
  afterwordHtml: string | null;
}

export interface BackupEpisodeResponse {
  novel: { id: number; site: SiteId; novelKey: string; title: string; url: string };
  episode: {
    id: number;
    episodeKey: string;
    position: number;
    title: string;
    chapter: string | null;
    publishedAt: string | null;
    siteUpdatedAt: string | null;
    removedAt: string | null;
    prevEpisodeId: number | null;
    nextEpisodeId: number | null;
  };
  version: EpisodeVersionBody;
  versions: EpisodeVersionSummary[];
}

export interface BackupStatus {
  running: boolean;
  runningAll: boolean;
  currentNovel: { id: number; title: string } | null;
  queueLength: number;
  nextRunAt: string | null;
}

export interface BackupRun {
  id: number;
  trigger: "schedule" | "manual" | "bookmark" | "novel";
  startedAt: string;
  finishedAt: string | null;
  status: "running" | "success" | "partial" | "failed";
  novelsChecked: number;
  episodesFetched: number;
  versionsAdded: number;
  errors: { novelId: number; message: string }[];
}
