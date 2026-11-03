import express, { type ErrorRequestHandler, type Express } from "express";
import type { Db } from "./db/index.js";
import { NotificationRepository } from "./db/notification.repository.js";
import { loadSession } from "./auth/session.js";
import { sendError } from "./http/errors.js";
import { securityHeaders } from "./http/security.js";
import type { BackupScheduler } from "./backup/scheduler.js";
import { authRouter } from "./routes/auth.js";
import { bookmarksRouter } from "./routes/bookmarks.js";
import { readingProgressRouter } from "./routes/readingProgress.js";
import { historyRouter } from "./routes/history.js";
import { usersRouter } from "./routes/users.js";
import { notificationsRouter } from "./routes/notifications.js";
import { createBackupRoutes } from "./routes/backup.js";
import { downloadRouter } from "./routes/download.js";

export interface AppContext {
  db: Db;
  notificationRepository: NotificationRepository;
}

export interface CreateAppOptions {
  db: Db;
  /** 公開ダウンロード用 APK の配置ディレクトリ(省略時は /download を無効化) */
  apkDir?: string;
  /** 初回管理者作成に必要なトークン(環境変数 SETUP_TOKEN)。未設定なら /api/auth/setup は無効 */
  setupToken?: string;
  /** バックアップスケジューラの取得関数(省略時はグローバル。テストで差し替え) */
  getScheduler?: () => BackupScheduler;
}

export function createApp({ db, apkDir, setupToken, getScheduler }: CreateAppOptions): Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", "loopback");

  const ctx: AppContext = {
    db,
    notificationRepository: new NotificationRepository(db),
  };

  app.use(securityHeaders);
  // 認証系は小さく、その他も控えめに(body-parser は最初に解釈した側が優先される)
  app.use("/api/auth", express.json({ limit: "16kb" }));
  app.use(express.json({ limit: "256kb" }));
  app.use(loadSession(db));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, name: "novel-backup", version: "0.2.0" });
  });

  app.use("/api/auth", authRouter(db, { setupToken }));
  app.use("/api/users", usersRouter(db));
  app.use("/api/bookmarks", bookmarksRouter(db));
  app.use("/api/history", historyRouter(db));
  app.use("/api/reading-progress", readingProgressRouter(db));
  app.use("/api/notifications", notificationsRouter(ctx));
  app.use("/api/backup", createBackupRoutes(db, { getScheduler }));
  if (apkDir) app.use("/download", downloadRouter(apkDir));

  app.use((_req, res) => sendError(res, 404, "not_found"));

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    const status = typeof err?.status === "number" && err.status >= 400 && err.status < 500 ? err.status : 500;
    if (status === 500) console.error("[error]", err);
    sendError(res, status, status === 500 ? "internal_error" : "bad_request");
  };
  app.use(onError);

  return app;
}
