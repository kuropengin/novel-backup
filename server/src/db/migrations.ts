import type { DatabaseSync } from "node:sqlite";

/** user_version = 適用済み件数。末尾に追記していく(既存要素は変更しない)。 */
export const migrations: string[] = [
  // 1: 初期スキーマ 
  `
CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin','viewer')),
  created_at    TEXT NOT NULL
);

CREATE TABLE sessions (
  id_hash    TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE novels (
  id              INTEGER PRIMARY KEY,
  site            TEXT NOT NULL CHECK (site IN ('hameln','narou','kakuyomu')),
  novel_key       TEXT NOT NULL,
  title           TEXT NOT NULL DEFAULT '',
  author          TEXT NOT NULL DEFAULT '',
  url             TEXT NOT NULL,
  site_status     TEXT NOT NULL DEFAULT 'unknown',
  is_deleted_on_site INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  last_checked_at TEXT,
  last_changed_at TEXT,
  last_error      TEXT,
  UNIQUE (site, novel_key)
);

CREATE TABLE novel_meta_versions (
  id         INTEGER PRIMARY KEY,
  novel_id   INTEGER NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
  version    INTEGER NOT NULL,
  hash       TEXT NOT NULL,
  meta_json  TEXT NOT NULL,
  toc_json   TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  UNIQUE (novel_id, version)
);

CREATE TABLE episodes (
  id            INTEGER PRIMARY KEY,
  novel_id      INTEGER NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
  episode_key   TEXT NOT NULL,
  position      INTEGER NOT NULL,
  title         TEXT NOT NULL,
  chapter       TEXT,
  site_published_at TEXT,
  site_updated_at   TEXT,
  removed_at    TEXT,
  created_at    TEXT NOT NULL,
  UNIQUE (novel_id, episode_key)
);

CREATE TABLE episode_versions (
  id              INTEGER PRIMARY KEY,
  episode_id      INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  version         INTEGER NOT NULL,
  content_hash    TEXT NOT NULL,
  title           TEXT NOT NULL,
  preface_html    TEXT,
  body_html       TEXT NOT NULL,
  afterword_html  TEXT,
  site_updated_at TEXT,
  fetched_at      TEXT NOT NULL,
  UNIQUE (episode_id, version)
);

CREATE TABLE bookmarks (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  novel_id   INTEGER NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
  note       TEXT NOT NULL DEFAULT '',
  last_read_episode_key TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (user_id, novel_id)
);

CREATE TABLE backup_runs (
  id          INTEGER PRIMARY KEY,
  trigger     TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  status      TEXT NOT NULL,
  novels_checked   INTEGER NOT NULL DEFAULT 0,
  episodes_fetched INTEGER NOT NULL DEFAULT 0,
  versions_added   INTEGER NOT NULL DEFAULT 0,
  errors_json TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX idx_episodes_novel ON episodes(novel_id, position);
CREATE INDEX idx_ep_versions_episode ON episode_versions(episode_id, version);
CREATE INDEX idx_bookmarks_user ON bookmarks(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);
`,
  // 2: アプリ専用化。バックアップ/設定関連テーブルを削除(users / sessions / novels / bookmarks は保持。
  //    novels の未使用カラムはテーブル再構築を避けるためそのまま残す)
  `
DROP TABLE IF EXISTS episode_versions;
DROP TABLE IF EXISTS episodes;
DROP TABLE IF EXISTS novel_meta_versions;
DROP TABLE IF EXISTS backup_runs;
DROP TABLE IF EXISTS settings;
`,
  // 3: 閲覧履歴(ユーザー毎。作品ページは episode_key = '')
  `
CREATE TABLE history (
  id            INTEGER PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  site          TEXT NOT NULL CHECK (site IN ('hameln','narou','kakuyomu')),
  novel_key     TEXT NOT NULL,
  episode_key   TEXT NOT NULL DEFAULT '',
  novel_title   TEXT NOT NULL DEFAULT '',
  episode_title TEXT NOT NULL DEFAULT '',
  url           TEXT NOT NULL,
  viewed_at     TEXT NOT NULL,
  UNIQUE (user_id, site, novel_key, episode_key)
);
CREATE INDEX idx_history_user_viewed ON history(user_id, viewed_at DESC);
`,
];

export function runMigrations(db: DatabaseSync): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  for (let v = row.user_version; v < migrations.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(migrations[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
}
