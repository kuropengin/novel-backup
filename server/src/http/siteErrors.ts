import type { Response } from "express";
import { SiteBlockedError, SiteNotFoundError, SiteParseError } from "../sites/types.js";
import { isHamelnCookieConfigured, isHamelnHost } from "./politeFetch.js";
import { sendError } from "./errors.js";

/** アダプタ/politeFetch の例外を HTTP 応答にする。 */
export function sendSiteError(res: Response, e: unknown): void {
  if (e instanceof SiteNotFoundError) return sendError(res, 404, "not_found", "サイト上に作品または話が見つかりません");
  if (e instanceof SiteBlockedError) {
    const hameln = /https?:\/\/([^/\s]+)/.exec(e.message)?.[1];
    const msg =
      e.reason === "challenge" && hameln && isHamelnHost(hameln)
        ? isHamelnCookieConfigured()
          ? "ハーメルンのボット対策により取得できませんでした。設定した Cookie / User-Agent が期限切れか、ブラウザと IP・UA が異なる可能性があります。管理設定の「ハーメルン接続」を更新してください"
          : "ハーメルンのボット対策(Cloudflare)により取得できませんでした。管理設定の「ハーメルン接続」でブラウザの Cookie と User-Agent を設定してください"
        : e.reason === "challenge"
          ? "サイト側のボット対策(Cloudflare 等)により、このサーバーからは取得できませんでした"
        : e.reason === "age-gate"
          ? "年齢確認ページのため取得できませんでした"
          : "サイトから取得をブロックされました";
    return sendError(res, 502, "site_blocked", msg);
  }
  if (e instanceof SiteParseError) return sendError(res, 502, "site_parse_error", "サイトの構造が想定と異なり解析できませんでした");
  console.error("[upstream]", e instanceof Error ? e.message : e);
  sendError(res, 502, "upstream_error", "サイトからの取得に失敗しました");
}
