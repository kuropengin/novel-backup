import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runMigrations } from "./migrations.js";

export type Db = DatabaseSync;

/** file に ":memory:" を渡すとメモリ DB(テスト用)。 */
export function openDb(file: string): Db {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  if (file !== ":memory:") db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  runMigrations(db);
  return db;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** BEGIN/COMMIT で包む。例外時は ROLLBACK。 */
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
