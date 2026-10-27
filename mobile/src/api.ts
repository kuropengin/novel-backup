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
}

export interface SaveInput {
  url: string;
  title?: string;
  author?: string;
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

export async function login(serverUrl: string, username: string, password: string) {
  const r = await call<{ token: string; user: { username: string } }>({ serverUrl, token: "" }, "POST", "/api/auth/token", { username, password }, false);
  return r.data;
}

export async function logout(cfg: ApiConfig): Promise<void> {
  await call(cfg, "POST", "/api/auth/logout", {});
}

export async function listBookmarks(cfg: ApiConfig): Promise<Bookmark[]> {
  return (await call<{ bookmarks: Bookmark[] }>(cfg, "GET", "/api/bookmarks")).data.bookmarks;
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
};

export function errorMessage(e: unknown): string {
  if (e instanceof NetworkError) return "サーバーに接続できません";
  if (e instanceof ApiError) return MESSAGES[e.code] ?? e.message;
  return e instanceof Error ? e.message : String(e);
}
