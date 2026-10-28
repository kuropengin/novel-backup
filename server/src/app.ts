import express, { type ErrorRequestHandler, type Express } from "express";
import type { Db } from "./db/index.js";
import { loadSession } from "./auth/session.js";
import { sendError } from "./http/errors.js";
import { RateLimiter } from "./http/rateLimit.js";
import { authRouter } from "./routes/auth.js";
import { bookmarksRouter } from "./routes/bookmarks.js";
import { historyRouter } from "./routes/history.js";
import { usersRouter } from "./routes/users.js";

export interface CreateAppOptions {
  db: Db;
}

/** API 専用(Bearer トークン認証)。テストから `createApp({ db })` で生成できる。listen はしない。 */
export function createApp({ db }: CreateAppOptions): Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", "loopback");

  app.use(express.json({ limit: "1mb" }));
  app.use(loadSession(db));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, name: "novel-backup", version: "0.2.0" });
  });

  app.use("/api/auth", authRouter(db, { loginLimiter: new RateLimiter(10, 60_000) }));
  app.use("/api/users", usersRouter(db));
  app.use("/api/bookmarks", bookmarksRouter(db));
  app.use("/api/history", historyRouter(db));

  // 未定義のパスは 404 JSON
  app.use((_req, res) => sendError(res, 404, "not_found"));

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    // body-parser の JSON 構文エラー等
    const status = typeof err?.status === "number" && err.status >= 400 && err.status < 500 ? err.status : 500;
    if (status === 500) console.error("[error]", err);
    sendError(res, status, status === 500 ? "internal_error" : "bad_request");
  };
  app.use(onError);

  return app;
}
