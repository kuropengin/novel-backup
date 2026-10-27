import type { NextFunction, Request, Response } from "express";
import { SESSION_COOKIE } from "../auth/session.js";
import { sendError } from "./errors.js";

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** 状態変更系: Content-Type: application/json 必須 + Origin があれば Host 一致を確認。 */
export function csrfGuard(allowedOrigins: string[] = []) {
  return (req: Request, res: Response, next: NextFunction) => {
  if (!UNSAFE.has(req.method)) return next();
  // Bearer で認証され Cookie を伴わないリクエストは、ブラウザが自動付与する資格情報を使わないため CSRF の対象外
  if (req.authViaBearer && !req.cookies?.[SESSION_COOKIE]) return next();
  if (!req.is("application/json")) {
    return sendError(res, 415, "unsupported_media_type", "Content-Type must be application/json");
  }
  const origin = req.headers.origin;
  if (origin) {
    let ok = false;
    try {
      const u = new URL(origin);
      // Host に加え、リバースプロキシが付ける X-Forwarded-Host も許可(Host を書き換えるプロキシ対策)
      const forwarded = String(req.headers["x-forwarded-host"] || "").split(",")[0].trim();
      ok = u.host === req.headers.host || (!!forwarded && u.host === forwarded) || allowedOrigins.includes(u.origin);
    } catch {
      ok = false;
    }
    if (!ok) {
      console.warn(`[csrf] bad_origin: origin=${origin} host=${req.headers.host} x-forwarded-host=${req.headers["x-forwarded-host"] ?? "-"} (ALLOWED_ORIGINS で許可可能)`);
      return sendError(res, 403, "bad_origin", "Origin が一致しません。リバースプロキシ経由の場合は ALLOWED_ORIGINS を設定してください");
    }
  }
  next();
  };
}
