import fs from "node:fs";
import path from "node:path";
import cookieParser from "cookie-parser";
import express, { type ErrorRequestHandler, type Express } from "express";
import type { Db } from "./db/index.js";
import { loadConfig, type Config } from "./config.js";
import { loadSession } from "./auth/session.js";
import { csrfGuard } from "./http/csrf.js";
import { sendError } from "./http/errors.js";
import { RateLimiter } from "./http/rateLimit.js";
import { createLiveService } from "./live/service.js";
import { BackupScheduler } from "./backup/scheduler.js";
import { backupsRouter } from "./routes/backups.js";
import { bookmarksRouter } from "./routes/bookmarks.js";
import { liveRouter } from "./routes/live.js";
import { proxyRouter, type ProxyDeps } from "./routes/proxy.js";
import { getAdapter } from "./sites/index.js";
import type { SiteAdapter, SiteId } from "./sites/types.js";
import { authRouter } from "./routes/auth.js";
import { settingsRouter } from "./routes/settings.js";
import { usersRouter } from "./routes/users.js";

export interface CreateAppOptions {
  db: Db;
  config?: Partial<Config>;
  /** テスト用: アダプタ取得の差し替え(ライブ/ブックマーク) */
  getAdapter?: (site: SiteId) => SiteAdapter;
  /** テスト用: Proxy の外部取得の差し替え */
  proxy?: ProxyDeps;
  /** バックアップ scheduler。省略時は未開始(定期実行なし)のものを内部生成する */
  scheduler?: BackupScheduler;
}

/** テストから `createApp({ db })` で生成できる。listen はしない。 */
export function createApp({ db, config: override, getAdapter: adapterOverride, proxy, scheduler: schedulerOverride }: CreateAppOptions): Express {
  const config: Config = { ...loadConfig(), ...override };
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", "loopback");

  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());
  app.use(loadSession(db));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, name: "novel-backup", version: "0.1.0" });
  });

  app.use("/api", csrfGuard(config.allowedOrigins));
  app.use("/api/auth", authRouter(db, { cookieSecure: config.cookieSecure, loginLimiter: new RateLimiter(10, 60_000) }));
  app.use("/api/users", usersRouter(db));
  app.use("/api/settings", settingsRouter(db));

  const live = createLiveService(adapterOverride ?? getAdapter);
  app.use("/api/live", liveRouter(db, live));
  app.use("/api/bookmarks", bookmarksRouter(db, live));
  const scheduler = schedulerOverride ?? new BackupScheduler({ db, getAdapter: adapterOverride ?? getAdapter });
  app.use("/api/backups", backupsRouter(db, scheduler));

  // /proxy/* は認証必須(未ログインは 401 のプレーンテキスト)。GET のみ
  app.use("/proxy", proxyRouter(proxy));

  // 未定義の /api は 404 JSON
  app.use("/api", (_req, res) => sendError(res, 404, "not_found"));

  // 本番: client/dist を同一 origin で配信 + SPA fallback
  const indexHtml = path.join(config.clientDist, "index.html");
  if (fs.existsSync(indexHtml)) app.use(express.static(config.clientDist));
  app.use((req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") return sendError(res, 404, "not_found");
    if (fs.existsSync(indexHtml)) return void res.sendFile(indexHtml);
    res.status(404).send("client not built. run: npm run build");
  });

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    // body-parser の JSON 構文エラー等
    const status = typeof err?.status === "number" && err.status >= 400 && err.status < 500 ? err.status : 500;
    if (status === 500) console.error("[error]", err);
    sendError(res, status, status === 500 ? "internal_error" : "bad_request");
  };
  app.use(onError);

  return app;
}
