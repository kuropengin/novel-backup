import path from "node:path";
import { createApp, type AppContext } from "./app.js";
import { loadConfig } from "./config.js";
import { cleanupExpiredSessions } from "./auth/session.js";
import { openDb } from "./db/index.js";
import { initBackupSystem, shutdownBackupSystem, presets } from "./backup/index.js";
import { createRealDeps, initPythonUpdater, resolveScraperPython, type PythonUpdater } from "./backup/pythonUpdater.js";
import { readBackupScheduleSettings } from "./backup/settings.js";

export type { AppContext };

const config = loadConfig();
const db = openDb(path.join(config.dataDir, "novel-backup.db"));

// 起動時と 1 時間毎に期限切れトークンを削除
cleanupExpiredSessions(db);
setInterval(() => cleanupExpiredSessions(db), 60 * 60 * 1000).unref();

const presetByFrequency = {
  hourly: presets.hourlySafe,
  daily: presets.standard,
  weekly: presets.light,
} as const;

const backupPreset = presetByFrequency[config.backupFrequency];
const persistedSchedule = readBackupScheduleSettings(db, {
  frequency: config.backupFrequency,
  time: config.backupTime,
  maxParallel: config.backupMaxParallel,
});
const app = createApp({
  db,
  apkDir: path.join(config.dataDir, "apk"),
  setupToken: config.setupToken,
  trustProxy: config.trustProxy,
});
let pythonUpdater: PythonUpdater | null = null;
const server = app.listen(config.port, config.host, async (err?: Error) => {
  // Express 5 は listen 失敗時もこのコールバックを呼ぶ。失敗の処理は server.on("error") に任せる
  if (err) return;
  console.log(`novel-backup server: http://${config.host}:${config.port}`);
  if (!config.setupToken && (db.prepare("SELECT COUNT(*) AS c FROM users").get() as unknown as { c: number }).c === 0) {
    console.warn("[Boot] SETUP_TOKEN が未設定のため、初回管理者の作成(/api/auth/setup)は無効です");
  }
  // ポート確保に成功してから起動する（二重起動時に稼働中プロセスのタスクを巻き戻さないため）
  // 依存更新の失敗はバックアップに影響させない(initPythonUpdater は例外を投げない)。
  // 稼働前に overlay の整合を取るため、バックアップ開始の前に待つ
  pythonUpdater = await initPythonUpdater({
    enabled: config.scraplingAutoUpdate,
    dataDir: config.dataDir,
    pythonBin: config.backupPythonBin,
    time: config.scraplingUpdateTime,
  });
  try {
    const image = await createRealDeps(config.backupPythonBin).probeBaseline();
    const scraperPython = resolveScraperPython(config.backupPythonBin);
    const runtime = await createRealDeps(scraperPython).selfTest(scraperPython);
    const activeOverlay = pythonUpdater?.readState().active?.version ?? "none";
    console.log(
      `[Boot] Versions: node=${process.version}, python(image)=${image.pythonMinor}, scrapling(image)=${image.version ?? "none"}, python(scraper)=${runtime.python}, scrapling(scraper)=${runtime.scrapling}, overlay=${activeOverlay}`
    );
  } catch (e) {
    console.warn("[Boot] Version probe failed:", e);
  }
  initBackupSystem(db, {
    ...backupPreset,
    frequency: persistedSchedule.frequency,
    maxParallel: persistedSchedule.maxParallel,
    pythonBin: config.backupPythonBin,
    time: persistedSchedule.time,
  });
  console.log("[Boot] Backup system initialized");
});
server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`[Boot] ポート ${config.port} は使用中です。既に起動しているサーバーを停止してから再実行してください。`);
    process.exit(1);
  }
  throw err;
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    shutdownBackupSystem();
    pythonUpdater?.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
