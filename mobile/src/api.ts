import { CapacitorHttp } from "@capacitor/core";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string,
    /** 429 のとき、再試行までの秒数(Retry-After / retryAfter) */
    public retryAfter?: number,
  ) {
    super(message || code);
  }
}

/** サーバーに到達できない(接続拒否・タイムアウト・名前解決失敗など) */
export class NetworkError extends Error {}

export interface Bookmark {
  id: number;
  site: string;
  novelKey: string;
  title: string;
  author: string;
  url: string;
  note?: string;
  createdAt: string;
  lastBackupMetadataAt?: string | null;
  lastBackupAllAt?: string | null;
  backupEpisodeCount?: number;
  /** 元サイトで最新話が更新された日時(ISO) */
  sourceUpdatedAt?: string | null;
  /** 既読話数・最後に読んだ話(サーバー側の読書進捗) */
  readEpisodeCount?: number;
  lastReadEpisodeKey?: string | null;
  lastReadAt?: string | null;
}

export interface ReadingProgress {
  readEpisodeKeys: string[];
  lastReadEpisodeKey: string | null;
  lastReadAt: string | null;
}

export interface Notification {
  id: number;
  type: "backup" | "error";
  title: string;
  message?: string;
  novelKey?: string;
  read: boolean;
  createdAt: string;
}

export interface BackupEpisode {
  episodeKey: string;
  position: number;
  title: string;
  bodyHtml: string;
  prefaceHtml?: string | null;
  afterwordHtml?: string | null;
  updatedAt?: string | null;
  /** 元サイトでの公開日時 */
  publishedAt?: string | null;
  fetchedAt: string;
  version: number;
}

export interface BackupScheduleSettings {
  frequency: "hourly" | "daily" | "weekly";
  time: string;
  maxParallel: number;
}

export interface BackupStatus {
  running: boolean;
  frequency: "hourly" | "daily" | "weekly";
  currentRunId: number | null;
  taskStats: { pending: number; inProgress: number; completed: number; failed: number };
}

export interface HistoryItem {
  id: number;
  site: string;
  novelKey: string;
  episodeKey: string;
  novelTitle: string;
  episodeTitle: string;
  url: string;
  viewedAt: string;
  /** view=novel のときのみ: 閲覧した話数 */
  episodeCount?: number;
}

export interface HistoryInput {
  url: string;
  novelTitle?: string;
  episodeTitle?: string;
  viewedAt?: string;
}

export interface SaveInput {
  url: string;
  title: string;
  author?: string;
}

export type Role = "admin" | "viewer";
export interface User {
  id: number;
  username: string;
  role: Role;
  createdAt: string;
}
export interface TokenResult {
  token: string;
  expiresAt: string;
  user: { id: number; username: string; role: Role };
}
export interface AuthStatus {
  setupRequired: boolean;
  user: { id: number; username: string; role: Role } | null;
}

/** 広告ブロック用リスト。presetKey が文字列ならプリセット(削除不可)、null ならユーザー追加 */
export interface Blocklist {
  id: number;
  presetKey: string | null;
  name: string;
  url: string;
  enabled: boolean;
}

export interface ApiConfig {
  serverUrl: string;
  token: string;
}

async function call<T>(cfg: ApiConfig, method: string, path: string, body?: unknown, auth = true): Promise<{ status: number; data: T }> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (auth && cfg.token) headers.Authorization = `Bearer ${cfg.token}`;
  if (method !== "GET") headers["Content-Type"] = "application/json";
  let res;
  try {
    res = await CapacitorHttp.request({
      url: `${cfg.serverUrl}${path}`,
      method,
      headers,
      data: method === "GET" ? undefined : (body ?? {}),
      connectTimeout: 10_000,
      readTimeout: 20_000,
    });
  } catch (e) {
    throw new NetworkError(e instanceof Error ? e.message : String(e));
  }
  let data = res.data as unknown;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch {
      /* JSON 以外はそのまま */
    }
  }
  if (res.status >= 400) {
    const d = (data ?? {}) as { error?: string; message?: string; retryAfter?: number };
    let retryAfter = typeof d.retryAfter === "number" ? d.retryAfter : undefined;
    if (retryAfter === undefined && res.status === 429) {
      const h = Object.entries(res.headers ?? {}).find(([k]) => k.toLowerCase() === "retry-after")?.[1];
      const n = Number(h);
      if (Number.isFinite(n) && n > 0) retryAfter = n;
    }
    throw new ApiError(res.status, d.error ?? `http_${res.status}`, d.message, retryAfter);
  }
  return { status: res.status, data: data as T };
}

export async function authStatus(serverUrl: string, token = ""): Promise<AuthStatus> {
  return (await call<AuthStatus>({ serverUrl, token }, "GET", "/api/auth/status")).data;
}

export async function login(serverUrl: string, username: string, password: string): Promise<TokenResult> {
  return (await call<TokenResult>({ serverUrl, token: "" }, "POST", "/api/auth/token", { username, password }, false)).data;
}

/** 初回のみ: 最初の管理者を作成し、そのままトークンを受け取る */
export async function setupAdmin(serverUrl: string, username: string, password: string, setupToken: string): Promise<TokenResult> {
  return (await call<TokenResult>({ serverUrl, token: "" }, "POST", "/api/auth/setup", { username, password, setupToken, token: true }, false)).data;
}

export async function changePassword(cfg: ApiConfig, currentPassword: string, newPassword: string): Promise<void> {
  await call(cfg, "POST", "/api/auth/password", { currentPassword, newPassword });
}

export async function listUsers(cfg: ApiConfig): Promise<User[]> {
  return (await call<{ users: User[] }>(cfg, "GET", "/api/users")).data.users;
}

export async function createUser(cfg: ApiConfig, input: { username: string; password: string; role: Role }): Promise<User> {
  return (await call<{ user: User }>(cfg, "POST", "/api/users", input)).data.user;
}

export async function updateUser(cfg: ApiConfig, id: number, patch: { role?: Role; password?: string }): Promise<User> {
  return (await call<{ user: User }>(cfg, "PATCH", `/api/users/${id}`, patch)).data.user;
}

export async function deleteUser(cfg: ApiConfig, id: number): Promise<void> {
  await call(cfg, "DELETE", `/api/users/${id}`);
}

export async function logout(cfg: ApiConfig): Promise<void> {
  await call(cfg, "POST", "/api/auth/logout", {});
}

export async function listBookmarks(cfg: ApiConfig): Promise<Bookmark[]> {
  return (await call<{ bookmarks: Bookmark[] }>(cfg, "GET", "/api/bookmarks")).data.bookmarks;
}

/** 表示中ページ(話ページでも可)の★状態 */
export async function lookupBookmark(cfg: ApiConfig, url: string): Promise<{ bookmarked: boolean; bookmarkId: number | null }> {
  return (await call<{ bookmarked: boolean; bookmarkId: number | null }>(cfg, "GET", `/api/bookmarks/lookup?url=${encodeURIComponent(url)}`)).data;
}

export async function postHistory(cfg: ApiConfig, input: HistoryInput): Promise<HistoryItem> {
  return (await call<{ history: HistoryItem }>(cfg, "POST", "/api/history", input)).data.history;
}

export async function listHistory(cfg: ApiConfig, view: "episode" | "novel", q = "", limit = 200): Promise<HistoryItem[]> {
  const qs = new URLSearchParams({ view, limit: String(limit) });
  if (q.trim()) qs.set("q", q.trim());
  return (await call<{ history: HistoryItem[] }>(cfg, "GET", `/api/history?${qs}`)).data.history;
}

export async function deleteHistory(cfg: ApiConfig, id: number): Promise<void> {
  await call(cfg, "DELETE", `/api/history/${id}`);
}

/** 作品単位で閲覧履歴を削除 */
export async function deleteHistoryNovel(cfg: ApiConfig, site: string, novelKey: string): Promise<void> {
  const qs = new URLSearchParams({ site, novelKey });
  await call(cfg, "DELETE", `/api/history?${qs}`);
}

export async function saveBookmark(cfg: ApiConfig, input: SaveInput): Promise<{ created: boolean; bookmark: Bookmark }> {
  const r = await call<{ created: boolean; bookmark: Bookmark }>(cfg, "POST", "/api/bookmarks", input);
  return r.data;
}

export async function deleteBookmark(cfg: ApiConfig, id: number): Promise<void> {
  await call(cfg, "DELETE", `/api/bookmarks/${id}`);
}

export async function listNotifications(cfg: ApiConfig): Promise<{ notifications: Notification[]; unreadCount: number }> {
  return (await call<{ notifications: Notification[]; unreadCount: number }>(cfg, "GET", "/api/notifications")).data;
}

export async function markNotificationAsRead(cfg: ApiConfig, notificationId: number): Promise<void> {
  await call(cfg, "POST", `/api/notifications/${notificationId}/read`);
}

export async function deleteNotification(cfg: ApiConfig, notificationId: number): Promise<void> {
  await call(cfg, "DELETE", `/api/notifications/${notificationId}`);
}

export async function triggerNovelBackup(cfg: ApiConfig, site: string, novelKey: string): Promise<void> {
  try {
    await call(cfg, "POST", `/api/backup/novels/${encodeURIComponent(site)}/${encodeURIComponent(novelKey)}/trigger`, {});
  } catch (e) {
    // 即時バックアップ専用の回数制限メッセージにするため、コードを差し替える
    if (e instanceof ApiError && e.status === 429) throw new ApiError(429, "backup_rate_limited", undefined, e.retryAfter);
    throw e;
  }
}

export async function listBackupEpisodes(cfg: ApiConfig, site: string, novelKey: string): Promise<BackupEpisode[]> {
  const response = await call<{ episodes: BackupEpisode[] }>(
    cfg,
    "GET",
    `/api/backup/novels/${encodeURIComponent(site)}/${encodeURIComponent(novelKey)}/episodes`
  );
  return response.data.episodes;
}

export async function getReadingProgress(cfg: ApiConfig, site: string, novelKey: string): Promise<ReadingProgress> {
  const d = (await call<Partial<ReadingProgress>>(cfg, "GET", `/api/reading-progress/${encodeURIComponent(site)}/${encodeURIComponent(novelKey)}`)).data;
  return { readEpisodeKeys: d.readEpisodeKeys ?? [], lastReadEpisodeKey: d.lastReadEpisodeKey ?? null, lastReadAt: d.lastReadAt ?? null };
}

export async function setEpisodeRead(cfg: ApiConfig, site: string, novelKey: string, episodeKey: string, read: boolean): Promise<void> {
  await call(cfg, "PUT", `/api/reading-progress/${encodeURIComponent(site)}/${encodeURIComponent(novelKey)}/${encodeURIComponent(episodeKey)}`, { read });
}

export async function getBackupSettings(cfg: ApiConfig): Promise<BackupScheduleSettings> {
  const response = await call<{ settings: BackupScheduleSettings }>(cfg, "GET", "/api/backup/settings");
  return response.data.settings;
}

export async function updateBackupSettings(cfg: ApiConfig, settings: BackupScheduleSettings): Promise<BackupScheduleSettings> {
  const response = await call<{ settings: BackupScheduleSettings }>(cfg, "PUT", "/api/backup/settings", settings);
  return response.data.settings;
}

export async function getBackupStatus(cfg: ApiConfig): Promise<BackupStatus> {
  return (await call<BackupStatus>(cfg, "GET", "/api/backup/status")).data;
}

export async function listBlocklists(cfg: ApiConfig): Promise<Blocklist[]> {
  return (await call<{ lists: Blocklist[] }>(cfg, "GET", "/api/blocklists")).data.lists;
}

export async function addBlocklist(cfg: ApiConfig, input: { name: string; url: string }): Promise<Blocklist> {
  return (await call<{ list: Blocklist }>(cfg, "POST", "/api/blocklists", input)).data.list;
}

export async function setBlocklistEnabled(cfg: ApiConfig, id: number, enabled: boolean): Promise<Blocklist> {
  return (await call<{ list: Blocklist }>(cfg, "PATCH", `/api/blocklists/${id}`, { enabled })).data.list;
}

export async function deleteBlocklist(cfg: ApiConfig, id: number): Promise<void> {
  await call(cfg, "DELETE", `/api/blocklists/${id}`);
}

const MESSAGES: Record<string, string> = {
  invalid_credentials: "ユーザー名またはパスワードが正しくありません",
  too_many_requests: "試行回数が多すぎます。しばらく待ってから再試行してください",
  not_a_novel_page: "作品ページではありません",
  unauthorized: "ログインの有効期限が切れました。再ログインしてください",
  forbidden: "この操作には管理者権限が必要です",
  already_setup: "初期設定は完了済みです。ログインしてください",
  username_taken: "そのユーザー名は既に使われています",
  cannot_delete_self: "自分自身は削除できません",
  last_admin: "最後の管理者は削除・降格できません",
  not_found: "対象が見つかりません",
  setup_disabled: "サーバーで SETUP_TOKEN が設定されていないため初期設定できません",
  invalid_setup_token: "セットアップトークンが正しくありません",
  internal_error: "サーバーでエラーが発生しました。しばらくしてから再試行してください",
  blocklist_limit: "追加できるリストは 20 件までです。不要なリストを削除してください",
  blocklist_duplicate: "その URL は既に登録されています",
  blocklist_preset_undeletable: "プリインストールのリストは削除できません(オフにはできます)",
  validation_error: "入力内容が正しくありません(ユーザー名は英数字・_・- の 3〜32 文字、パスワードは 8〜128 文字)",
};

/** 秒数 → 「約N分」(1 分未満は「約1分」)。不明なら「しばらく」。 */
function waitText(sec?: number): string {
  if (!sec || sec <= 0) return "しばらく";
  return `約${Math.max(1, Math.ceil(sec / 60))}分`;
}

export function errorMessage(e: unknown): string {
  if (e instanceof NetworkError) return "サーバーに接続できません";
  if (e instanceof ApiError) {
    if (e.code === "backup_rate_limited") return `即時バックアップの回数制限中です。${waitText(e.retryAfter)}後に再度お試しください`;
    if (e.status === 429 && !MESSAGES[e.code]) return `リクエストが多すぎます。${waitText(e.retryAfter)}後に再度お試しください`;
    if (e.status >= 500 && !MESSAGES[e.code]) return MESSAGES.internal_error;
    return MESSAGES[e.code] ?? e.message;
  }
  return e instanceof Error ? e.message : String(e);
}
