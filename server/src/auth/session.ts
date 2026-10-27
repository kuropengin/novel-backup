import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { Db } from "../db/index.js";
import { nowIso } from "../db/index.js";
import { sendError } from "../http/errors.js";

export const SESSION_COOKIE = "nb_sid";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** モバイルアプリ用 Bearer トークンの有効期間 */
export const TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export type Role = "admin" | "viewer";
export interface SessionUser {
  id: number;
  username: string;
  role: Role;
}

declare module "express-serve-static-core" {
  interface Request {
    user?: SessionUser;
    /** 認証に使われたトークン(Cookie の sid または Bearer)。未認証なら undefined */
    authToken?: string;
    /** Bearer ヘッダで認証されたか */
    authViaBearer?: boolean;
  }
}

function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

export function createSession(db: Db, userId: number, ttlMs: number = SESSION_TTL_MS): { id: string; expiresAt: Date } {
  const id = crypto.randomBytes(32).toString("base64url");
  const now = Date.now();
  const expiresAt = new Date(now + ttlMs);
  db.prepare("INSERT INTO sessions (id_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(
    sha256(id),
    userId,
    new Date(now).toISOString(),
    expiresAt.toISOString(),
  );
  return { id, expiresAt };
}

export function resolveSession(db: Db, sid: string): SessionUser | null {
  const row = db
    .prepare(
      `SELECT u.id, u.username, u.role FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id_hash = ? AND s.expires_at > ?`,
    )
    .get(sha256(sid), nowIso()) as unknown as SessionUser | undefined;
  return row ? { id: row.id, username: row.username, role: row.role } : null;
}

export function deleteSession(db: Db, sid: string): void {
  db.prepare("DELETE FROM sessions WHERE id_hash = ?").run(sha256(sid));
}

/** exceptSid を指定するとそのセッションは残す。 */
export function deleteUserSessions(db: Db, userId: number, exceptSid?: string): void {
  if (exceptSid) {
    db.prepare("DELETE FROM sessions WHERE user_id = ? AND id_hash != ?").run(userId, sha256(exceptSid));
  } else {
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  }
}

export function cleanupExpiredSessions(db: Db): void {
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(nowIso());
}

export function sessionCookieOptions(secure: boolean, expires?: Date) {
  return { httpOnly: true, sameSite: "lax" as const, secure, path: "/", ...(expires ? { expires } : {}) };
}

/** Cookie または Authorization: Bearer からユーザーを解決して req.user を設定する middleware。 */
export function loadSession(db: Db) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const sid: unknown = req.cookies?.[SESSION_COOKIE];
    if (typeof sid === "string" && sid) {
      const user = resolveSession(db, sid);
      if (user) {
        req.user = user;
        req.authToken = sid;
      }
    }
    if (!req.user) {
      const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "");
      if (m) {
        const user = resolveSession(db, m[1]!);
        if (user) {
          req.user = user;
          req.authToken = m[1];
          req.authViaBearer = true;
        }
      }
    }
    next();
  };
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.user) return sendError(res, 401, "unauthorized");
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.user) return sendError(res, 401, "unauthorized");
  if (req.user.role !== "admin") return sendError(res, 403, "forbidden");
  next();
}
