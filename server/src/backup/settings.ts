import type { Db } from "../db/index.js";
import { nowIso } from "../db/index.js";
import type { ScheduleFrequency } from "./scheduler.js";

export interface BackupScheduleSettings {
  frequency: ScheduleFrequency;
  time: string;
  maxParallel: number;
}

const KEY_FREQUENCY = "frequency";
const KEY_TIME = "time";
const KEY_MAX_PARALLEL = "maxParallel";

export function readBackupScheduleSettings(db: Db, fallback: BackupScheduleSettings): BackupScheduleSettings {
  const rows = db.prepare("SELECT key, value FROM backup_settings").all() as Array<{ key: string; value: string }>;
  const map = new Map(rows.map((row) => [row.key, row.value]));

  const frequencyRaw = map.get(KEY_FREQUENCY);
  const frequency =
    frequencyRaw === "hourly" || frequencyRaw === "daily" || frequencyRaw === "weekly" ? frequencyRaw : fallback.frequency;
  const timeRaw = map.get(KEY_TIME);
  const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(timeRaw ?? "") ? (timeRaw as string) : fallback.time;
  const maxParallelRaw = Number(map.get(KEY_MAX_PARALLEL));
  const maxParallel = Number.isFinite(maxParallelRaw)
    ? Math.min(10, Math.max(1, Math.floor(maxParallelRaw)))
    : fallback.maxParallel;

  return { frequency, time, maxParallel };
}

export function writeBackupScheduleSettings(db: Db, settings: BackupScheduleSettings): void {
  const stmt = db.prepare(
    `INSERT INTO backup_settings (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  );
  const ts = nowIso();
  stmt.run(KEY_FREQUENCY, settings.frequency, ts);
  stmt.run(KEY_TIME, settings.time, ts);
  stmt.run(KEY_MAX_PARALLEL, String(settings.maxParallel), ts);
}
