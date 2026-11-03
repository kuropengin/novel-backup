import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrations, runMigrations } from "../src/db/migrations.js";

const tables = (db: DatabaseSync) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map(
    (r) => r.name,
  );

describe("migrations", () => {
  it("fresh db ends with users, sessions, novels, bookmarks, history", () => {
    const db = new DatabaseSync(":memory:");
    runMigrations(db);
    expect(tables(db)).toEqual([
      "backup_run_stats",
      "backup_settings",
      "backup_tasks",
      "bookmarks",
      "episode_versions",
      "episodes",
      "history",
      "notifications",
      "novel_meta_versions",
      "novels",
      "reading_progress",
      "sessions",
      "users",
    ]);
  });

  it("upgrades an old (v1) database and keeps users and bookmarks", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(migrations[0]!);
    db.exec("PRAGMA user_version = 1");
    db.exec(`
      INSERT INTO users (id, username, password_hash, role, created_at) VALUES (1, 'admin', 'h', 'admin', 't');
      INSERT INTO novels (id, site, novel_key, title, url, created_at) VALUES (1, 'narou', 'n1234ab', 'T', 'https://ncode.syosetu.com/n1234ab/', 't');
      INSERT INTO bookmarks (id, user_id, novel_id, note, created_at) VALUES (1, 1, 1, 'memo', 't');
      INSERT INTO episodes (id, novel_id, episode_key, position, title, created_at) VALUES (1, 1, '1', 0, 'e', 't');
      INSERT INTO episode_versions (episode_id, version, content_hash, title, body_html, fetched_at) VALUES (1, 1, 'h', 'e', 'b', 't');
      INSERT INTO settings (key, value) VALUES ('k', 'v');
      INSERT INTO backup_runs (trigger, started_at, status) VALUES ('manual', 't', 'ok');
    `);
    runMigrations(db);

    expect(tables(db)).toEqual([
      "backup_run_stats",
      "backup_settings",
      "backup_tasks",
      "bookmarks",
      "episode_versions",
      "episodes",
      "history",
      "notifications",
      "novel_meta_versions",
      "novels",
      "reading_progress",
      "sessions",
      "users",
    ]);
    expect(db.prepare("SELECT username FROM users").all()).toEqual([{ username: "admin" }]);
    expect(db.prepare("SELECT note, novel_id FROM bookmarks").all()).toEqual([{ note: "memo", novel_id: 1 }]);
    expect(db.prepare("SELECT title FROM novels").all()).toEqual([{ title: "T" }]);
    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(migrations.length);
  });
});
