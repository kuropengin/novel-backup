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
      "user_blocklists",
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
      "user_blocklists",
      "users",
    ]);
    expect(db.prepare("SELECT username FROM users").all()).toEqual([{ username: "admin" }]);
    expect(db.prepare("SELECT note, novel_id FROM bookmarks").all()).toEqual([{ note: "memo", novel_id: 1 }]);
    expect(db.prepare("SELECT title FROM novels").all()).toEqual([{ title: "T" }]);
    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(migrations.length);
  });

  it("v15 replaces kakuyomu version titles (work title) with the episode title and leaves other sites alone", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(migrations.slice(0, 14).join("\n"));
    db.exec("PRAGMA user_version = 14");
    db.exec(`
      INSERT INTO novels (id, site, novel_key, title, url, created_at) VALUES
        (1, 'kakuyomu', '111', '作品名', 'u', 't'),
        (2, 'narou', 'n1', '作品名', 'u', 't');
      INSERT INTO episodes (id, novel_id, episode_key, position, title, created_at) VALUES
        (1, 1, '11', 1, '第1話', 't'),
        (2, 2, '1', 1, '一覧の題', 't');
      INSERT INTO episode_versions (episode_id, version, content_hash, title, body_html, fetched_at) VALUES
        (1, 1, 'h', '作品名', 'b', 't'),
        (2, 1, 'h', '本文側の題', 'b', 't');
    `);
    runMigrations(db);
    expect(db.prepare("SELECT title FROM episode_versions ORDER BY episode_id").all()).toEqual([
      { title: "第1話" },
      { title: "本文側の題" },
    ]);
  });
});
