import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { Db } from "../db/index.js";
import { nowIso } from "../db/index.js";
import { hashPassword, verifyPassword } from "../auth/password.js";
import {
  SESSION_COOKIE,
  TOKEN_TTL_MS,
  createSession,
  deleteSession,
  deleteUserSessions,
  requireAuth,
  sessionCookieOptions,
  type Role,
} from "../auth/session.js";
import { ah, parseBody, sendError } from "../http/errors.js";
import { RateLimiter } from "../http/rateLimit.js";

export const usernameSchema = z.string().regex(/^[a-zA-Z0-9_-]{3,32}$/, "英数字・_・- の 3〜32 文字");
export const passwordSchema = z.string().min(8).max(128);

export interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  role: Role;
  created_at: string;
}

export function publicUser(u: UserRow) {
  return { id: u.id, username: u.username, role: u.role, createdAt: u.created_at };
}

const setupSchema = z.object({ username: usernameSchema, password: passwordSchema });
const loginSchema = z.object({ username: z.string().min(1).max(100), password: z.string().min(1).max(256) });
const changePasswordSchema = z.object({ currentPassword: z.string().min(1).max(256), newPassword: passwordSchema });

// ユーザー不在時にも bcrypt 比較を行い応答時間差を減らすためのダミー
const DUMMY_HASH = hashPassword("dummy-password-for-timing");

export interface AuthRouterOptions {
  cookieSecure: boolean;
  loginLimiter?: RateLimiter;
}

export function authRouter(db: Db, opts: AuthRouterOptions): Router {
  const r = Router();
  const limiter = opts.loginLimiter ?? new RateLimiter(10, 60_000);

  const userCount = () => (db.prepare("SELECT COUNT(*) AS c FROM users").get() as unknown as { c: number }).c;

  function startSession(res: Response, userId: number) {
    const { id, expiresAt } = createSession(db, userId);
    res.cookie(SESSION_COOKIE, id, sessionCookieOptions(opts.cookieSecure, expiresAt));
  }

  r.get("/status", (req, res) => {
    res.json({ setupRequired: userCount() === 0, user: req.user ?? null });
  });

  r.post(
    "/setup",
    ah(async (req, res) => {
      if (userCount() > 0) return sendError(res, 409, "already_setup");
      const body = parseBody(setupSchema, req, res);
      if (!body) return;
      const hash = await hashPassword(body.password);
      if (userCount() > 0) return sendError(res, 409, "already_setup"); // await 中の競合対策
      const info = db
        .prepare("INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, 'admin', ?)")
        .run(body.username, hash, nowIso());
      const id = Number(info.lastInsertRowid);
      startSession(res, id);
      res.status(201).json({ user: { id, username: body.username, role: "admin" } });
    }),
  );

  /** 資格情報を検証してユーザーを返す(失敗時はレスポンス送信済みで null)。login / token で共有。 */
  async function authenticate(req: Request, res: Response): Promise<UserRow | null> {
    if (!limiter.take(req.ip ?? "unknown")) {
      sendError(res, 429, "too_many_requests");
      return null;
    }
    const body = parseBody(loginSchema, req, res);
    if (!body) return null;
    const user = db.prepare("SELECT * FROM users WHERE username = ?").get(body.username) as unknown as UserRow | undefined;
    const ok = await verifyPassword(body.password, user?.password_hash ?? (await DUMMY_HASH));
    if (!user || !ok) {
      sendError(res, 401, "invalid_credentials");
      return null;
    }
    return user;
  }

  r.post(
    "/login",
    ah(async (req, res) => {
      const user = await authenticate(req, res);
      if (!user) return;
      startSession(res, user.id);
      res.json({ user: { id: user.id, username: user.username, role: user.role } });
    }),
  );

  // モバイルアプリ用: Cookie ではなく Bearer トークンを発行する(sessions テーブルを流用、90 日)
  r.post(
    "/token",
    ah(async (req, res) => {
      const user = await authenticate(req, res);
      if (!user) return;
      const { id, expiresAt } = createSession(db, user.id, TOKEN_TTL_MS);
      res.json({
        token: id,
        expiresAt: expiresAt.toISOString(),
        user: { id: user.id, username: user.username, role: user.role },
      });
    }),
  );

  r.post("/logout", requireAuth, (req, res) => {
    // Cookie セッション / Bearer トークンのどちらも失効させる
    if (req.authToken) deleteSession(db, req.authToken);
    res.clearCookie(SESSION_COOKIE, sessionCookieOptions(opts.cookieSecure));
    res.json({ ok: true });
  });

  r.post(
    "/password",
    requireAuth,
    ah(async (req, res) => {
      const body = parseBody(changePasswordSchema, req, res);
      if (!body) return;
      const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user!.id) as unknown as UserRow;
      if (!(await verifyPassword(body.currentPassword, user.password_hash))) {
        return sendError(res, 401, "invalid_credentials");
      }
      db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(await hashPassword(body.newPassword), user.id);
      // 他端末のセッションは破棄し、現在のセッションは維持
      deleteUserSessions(db, user.id, req.authToken);
      res.json({ ok: true });
    }),
  );

  return r;
}
