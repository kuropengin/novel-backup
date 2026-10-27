export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string,
    public details?: unknown,
  ) {
    super(message || code);
  }
}

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  /** true なら 401 でもログイン画面へ飛ばさない(ログイン試行・status 取得用) */
  noRedirect?: boolean;
}

/** fetch + same-origin Cookie + JSON。エラーは ApiError。 */
export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const method = opts.method ?? "GET";
  const init: RequestInit = { method, credentials: "same-origin", headers: { Accept: "application/json" } };
  if (method !== "GET") {
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
    init.body = JSON.stringify(opts.body ?? {});
  }
  const res = await fetch(path, init);
  let data: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    if (res.status === 401 && !opts.noRedirect) onUnauthorized?.();
    const d = (data ?? {}) as { error?: string; message?: string; details?: unknown };
    throw new ApiError(res.status, d.error ?? `http_${res.status}`, d.message, d.details);
  }
  return data as T;
}

const MESSAGES: Record<string, string> = {
  invalid_credentials: "ユーザー名またはパスワードが正しくありません",
  too_many_requests: "試行回数が多すぎます。しばらく待ってから再試行してください",
  username_taken: "そのユーザー名は既に使われています",
  already_setup: "既にセットアップ済みです",
  last_admin: "最後の管理者は変更・削除できません",
  cannot_delete_self: "自分自身は削除できません",
  validation_error: "入力内容を確認してください(ユーザー名は英数字・_・- の 3〜32 文字、パスワードは 8〜128 文字)",
  forbidden: "権限がありません",
  not_found: "見つかりませんでした(サイト上に存在しない可能性があります)",
  site_blocked: "サイト側のボット対策(Cloudflare 等)により取得できません。このサイトはサーバーからのアクセスが拒否されています。",
  site_parse_error: "サイトの構造が想定と異なり、解析できませんでした",
  upstream_error: "サイトからの取得に失敗しました。時間をおいて再度お試しください",
  already_running: "既にバックアップを実行中です",
  no_versions: "この話の本文はまだバックアップされていません",
  not_a_novel_page: "作品ページ(または話ページ)の URL ではありません",
};

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return MESSAGES[e.code] ?? e.message;
  return e instanceof Error ? e.message : String(e);
}
