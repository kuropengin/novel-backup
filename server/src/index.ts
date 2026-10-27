import path from "node:path";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { cleanupExpiredSessions } from "./auth/session.js";
import { BackupScheduler, markStaleRunsFailed } from "./backup/scheduler.js";
import { setBackupQueue } from "./backup/queue.js";
import { getAdapter } from "./sites/index.js";
import { openDb } from "./db/index.js";
import { configurePoliteFetch } from "./http/politeFetch.js";
import { getSettings } from "./settings.js";

const config = loadConfig();
const db = openDb(path.join(config.dataDir, "novel-backup.db"));

// 起動時と 1 時間毎に期限切れセッションを削除
cleanupExpiredSessions(db);
setInterval(() => cleanupExpiredSessions(db), 60 * 60 * 1000).unref();

// 外部取得の最小間隔は設定値(requestIntervalMs)に追従
configurePoliteFetch({
  getIntervalMs: () => getSettings(db).requestIntervalMs,
  getHamelnAuth: () => {
    const s = getSettings(db);
    return { cookie: s.hamelnCookie, userAgent: s.hamelnUserAgent };
  },
});

// 前回の異常終了で running のまま残った実行を failed にし、scheduler を開始する
const stale = markStaleRunsFailed(db);
if (stale > 0) console.log(`[backup] marked ${stale} stale run(s) as failed`);
const scheduler = new BackupScheduler({ db, getAdapter });
setBackupQueue(scheduler);
scheduler.start();

const app = createApp({ db, config, scheduler });
const server = app.listen(config.port, () => console.log(`novel-backup server: http://localhost:${config.port}`));

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    scheduler.stop();
    // 実行中の run は次回起動時に failed へ更新される
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
