import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { Db } from "../db/index.js";
import { nowIso } from "../db/index.js";
import crypto from "node:crypto";
import { hashPassword, needsRehash, verifyPassword } from "../auth/password.js";
import { createSession, deleteSession, deleteUserSessions, requireAuth, type Role } from "../auth/session.js";
import { ah, parseBody, sendError } from "../http/errors.js";
import { clientKey, FailureBackoff, RateLimiter } from "../http/rateLimit.js";

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

const setupSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  /** サーバーの環境変数 SETUP_TOKEN と一致する必要がある */
  setupToken: z.string().max(256).optional(),
});
const loginSchema = z.object({ username: z.string().min(1).max(100), password: z.string().min(1).max(256) });
const changePasswordSchema = z.object({ currentPassword: z.string().min(1).max(256), newPassword: passwordSchema });

// ユーザー不在時にも bcrypt 比較を行い応答時間差を減らすためのダミー
const DUMMY_HASH = hashPassword("dummy-password-for-timing");

export interface AuthRouterOptions {
  /** IP 単位のログイン試行制限 */
  loginLimiter?: RateLimiter;
  /** ユーザー名単位の失敗バックオフ(ロックアウト) */
  loginBackoff?: FailureBackoff;
  /** IP 単位の /setup 試行制限 */
  setupLimiter?: RateLimiter;
  /** ユーザー単位の /password 試行制限 */
  passwordLimiter?: RateLimiter;
  /** 初回セットアップ用トークン(未設定なら /setup は 403 setup_disabled) */
  setupToken?: string;
}

/** 長さ非依存の定数時間比較(双方を SHA-256 にしてから比較) */
function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function tooMany(res: Response, retryAfter: number) {
  res.setHeader("Retry-After", String(retryAfter));
  res.status(429).json({ error: "too_many_requests", retryAfter });
}

export function authRouter(db: Db, opts: AuthRouterOptions): Router {
  const r = Router();
  const limiter = opts.loginLimiter ?? new RateLimiter(10, 60_000);
  const backoff = opts.loginBackoff ?? new FailureBackoff();
  const setupLimiter = opts.setupLimiter ?? new RateLimiter(5, 60_000);
  const passwordLimiter = opts.passwordLimiter ?? new RateLimiter(10, 15 * 60_000);
  const setupToken = opts.setupToken;

  const userCount = () => (db.prepare("SELECT COUNT(*) AS c FROM users").get() as unknown as { c: number }).c;

  /** トークンを発行して { token, expiresAt, user } を返す */
  function tokenPayload(user: { id: number; username: string; role: Role }) {
    const { id, expiresAt } = createSession(db, user.id);
    return { token: id, expiresAt: expiresAt.toISOString(), user: { id: user.id, username: user.username, role: user.role } };
  }

  r.get("/status", (req, res) => {
    // setupEnabled: サーバーに SETUP_TOKEN が設定されているか(未設定だと初期設定できないことをアプリが案内できる)
    res.json({ setupRequired: userCount() === 0, setupEnabled: !!setupToken, user: req.user ?? null });
  });

  r.post(
    "/setup",
    ah(async (req, res) => {
      const key = clientKey(req);
      if (!setupLimiter.take(key)) return tooMany(res, setupLimiter.retryAfterSec(key));
      if (userCount() > 0) return sendError(res, 409, "already_setup");
      if (!setupToken) return sendError(res, 403, "setup_disabled");
      const body = parseBody(setupSchema, req, res);
      if (!body) return;
      if (!safeEqual(body.setupToken ?? "", setupToken)) return sendError(res, 403, "invalid_setup_token");
      const hash = await hashPassword(body.password);
      if (userCount() > 0) return sendError(res, 409, "already_setup"); // await 中の競合対策
      const info = db
        .prepare("INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, 'admin', ?)")
        .run(body.username, hash, nowIso());
      const id = Number(info.lastInsertRowid);
      res.status(201).json(tokenPayload({ id, username: body.username, role: "admin" }));
    }),
  );

  /** 資格情報を検証してユーザーを返す(失敗時はレスポンス送信済みで null)。 */
  async function authenticate(req: Request, res: Response): Promise<UserRow | null> {
    const key = clientKey(req);
    if (!limiter.take(key)) {
      tooMany(res, limiter.retryAfterSec(key));
      return null;
    }
    const body = parseBody(loginSchema, req, res);
    if (!body) return null;
    // ユーザー名単位の失敗バックオフ(存在しないユーザー名でも同様に数え、存在有無を漏らさない)
    const nameKey = body.username.toLowerCase();
    const locked = backoff.lockedFor(nameKey);
    if (locked > 0) {
      tooMany(res, locked);
      return null;
    }
    const user = db.prepare("SELECT * FROM users WHERE username = ?").get(body.username) as unknown as UserRow | undefined;
    const ok = await verifyPassword(body.password, user?.password_hash ?? (await DUMMY_HASH));
    if (!user || !ok) {
      backoff.fail(nameKey);
      sendError(res, 401, "invalid_credentials");
      return null;
    }
    backoff.success(nameKey);
    // 保存済みハッシュのコストが低ければ引き上げる
    if (needsRehash(user.password_hash)) {
      const rehashed = await hashPassword(body.password);
      db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(rehashed, user.id);
    }
    return user;
  }

  r.post(
    "/token",
    ah(async (req, res) => {
      const user = await authenticate(req, res);
      if (!user) return;
      res.json(tokenPayload(user));
    }),
  );

  r.post("/logout", requireAuth, (req, res) => {
    if (req.authToken) deleteSession(db, req.authToken);
    res.json({ ok: true });
  });

  r.post(
    "/password",
    requireAuth,
    ah(async (req, res) => {
      const key = `user:${req.user!.id}`;
      if (!passwordLimiter.take(key)) return tooMany(res, passwordLimiter.retryAfterSec(key));
      const body = parseBody(changePasswordSchema, req, res);
      if (!body) return;
      const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user!.id) as unknown as UserRow;
      if (!(await verifyPassword(body.currentPassword, user.password_hash))) {
        return sendError(res, 401, "invalid_credentials");
      }
      db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(await hashPassword(body.newPassword), user.id);
      // 他端末のトークンは破棄し、現在のトークンは維持
      deleteUserSessions(db, user.id, req.authToken);
      res.json({ ok: true });
    }),
  );

  return r;
}
