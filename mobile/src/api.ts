import { CapacitorHttp } from "@capacitor/core";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string,
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
    const d = (data ?? {}) as { error?: string; message?: string };
    throw new ApiError(res.status, d.error ?? `http_${res.status}`, d.message);
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
export async function setupAdmin(serverUrl: string, username: string, password: string): Promise<TokenResult> {
  return (await call<TokenResult>({ serverUrl, token: "" }, "POST", "/api/auth/setup", { username, password, token: true }, false)).data;
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
  validation_error: "入力内容が正しくありません(ユーザー名は英数字・_・- の 3〜32 文字、パスワードは 8〜128 文字)",
};

export function errorMessage(e: unknown): string {
  if (e instanceof NetworkError) return "サーバーに接続できません";
  if (e instanceof ApiError) return MESSAGES[e.code] ?? e.message;
  return e instanceof Error ? e.message : String(e);
}
