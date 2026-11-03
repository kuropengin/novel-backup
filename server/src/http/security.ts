import type { NextFunction, Request, Response } from "express";

/** 全レスポンスに付けるセキュリティヘッダ。HSTS は HTTPS(リバースプロキシの X-Forwarded-Proto 含む)のときだけ。 */
export function securityHeaders(req: Request, res: Response, next: NextFunction) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  if (req.secure) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  if (req.path.startsWith("/api/") || req.path === "/api") res.setHeader("Cache-Control", "no-store");
  next();
}

/** /download の HTML ページ用 CSP(インラインスタイルのみ許可) */
export const DOWNLOAD_PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
