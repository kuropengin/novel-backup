import path from "node:path";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { cleanupExpiredSessions } from "./auth/session.js";
import { openDb } from "./db/index.js";

const config = loadConfig();
const db = openDb(path.join(config.dataDir, "novel-backup.db"));

// 起動時と 1 時間毎に期限切れトークンを削除
cleanupExpiredSessions(db);
setInterval(() => cleanupExpiredSessions(db), 60 * 60 * 1000).unref();

const app = createApp({ db });
const server = app.listen(config.port, () => console.log(`novel-backup server: http://localhost:${config.port}`));

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
