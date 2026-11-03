/** バックアップシステムの型定義 */

export type SiteId = "hameln" | "narou" | "kakuyomu";
export type TaskType = "metadata" | "content" | "all";
export type BackupStatus = "pending" | "in_progress" | "completed" | "failed";

export interface NovelMetadata {
  title: string;
  author: string;
  description: string;
  status: string; // 連載中、完結、短編 など
  episodeCount: number;
  lastUpdated: string;
  url: string;
  tags?: string[];
  views?: number;
  bookmarks?: number;
}

export interface Episode {
  episodeKey: string;
  position: number;
  title: string;
  chapter?: string;
  publishedAt: string;
  updatedAt: string;
}

export interface EpisodeContent {
  title: string;
  prefaceHtml?: string;
  bodyHtml: string;
  afterwordHtml?: string;
  updatedAt: string;
}

export interface BackupTask {
  id: number;
  site: SiteId;
  novelKey: string;
  taskType: TaskType;
  status: BackupStatus;
  scheduledAt: string;
  startedAt?: string;
  completedAt?: string;
  errorMessage?: string;
  retryCount: number;
  maxRetries: number;
  priority: number;
  createdAt: string;
}

export interface BackupRunStats {
  id: number;
  startedAt: string;
  finishedAt?: string;
  status: "in_progress" | "completed" | "failed";
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  totalEpisodesScraped: number;
  errorsJson: string;
}

export interface BackupConfig {
  maxParallel: number;
  rateLimit: number; // upper bound requests per second
  randomRateMin: number; // requests per second
  randomRateMax: number; // requests per second
  maxRetries: number;
  backupScopes: readonly TaskType[];
  pythonBin: string;
  maxContentFetchPerNovel: number;
  checkInterval: number; // ms
}

export interface ScrapeResult {
  metadata?: NovelMetadata;
  episodes?: Episode[];
  content?: Map<string, EpisodeContent>; // episodeKey -> content
  errors: string[];
}

export type BackupPhase = "idle" | "enqueue" | "metadata" | "episodes" | "content" | "completed" | "failed";

export interface BackupProgressEvent {
  runId: number | null;
  phase: BackupPhase;
  site?: SiteId;
  novelKey?: string;
  message: string;
  currentTasks: number;
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  timestamp: string;
}
