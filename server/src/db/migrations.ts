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
  // 4: バックアップタスク管理テーブル
  `
CREATE TABLE backup_tasks (
  id              INTEGER PRIMARY KEY,
  site            TEXT NOT NULL CHECK (site IN ('hameln','narou','kakuyomu')),
  novel_key       TEXT NOT NULL,
  task_type       TEXT NOT NULL CHECK (task_type IN ('metadata', 'content', 'all')),
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'failed')),
  scheduled_at    TEXT NOT NULL,
  started_at      TEXT,
  completed_at    TEXT,
  error_message   TEXT,
  retry_count     INTEGER NOT NULL DEFAULT 0,
  max_retries     INTEGER NOT NULL DEFAULT 3,
  priority        INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  UNIQUE (site, novel_key, task_type, status)
);

CREATE TABLE backup_run_stats (
  id              INTEGER PRIMARY KEY,
  started_at      TEXT NOT NULL,
  finished_at     TEXT,
  status          TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'completed', 'failed')),
  total_tasks     INTEGER NOT NULL DEFAULT 0,
  completed_tasks INTEGER NOT NULL DEFAULT 0,
  failed_tasks    INTEGER NOT NULL DEFAULT 0,
  total_episodes_scraped INTEGER NOT NULL DEFAULT 0,
  errors_json     TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX idx_backup_tasks_status ON backup_tasks(status, scheduled_at);
CREATE INDEX idx_backup_tasks_priority ON backup_tasks(priority DESC, scheduled_at);
CREATE INDEX idx_backup_run_stats_started ON backup_run_stats(started_at DESC);
`,
  // 5: バックアップ本文保存テーブルを復活(既存環境の v2 で削除されているため)
  `
CREATE TABLE IF NOT EXISTS novel_meta_versions (
  id         INTEGER PRIMARY KEY,
  novel_id   INTEGER NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
  version    INTEGER NOT NULL,
  hash       TEXT NOT NULL,
  meta_json  TEXT NOT NULL,
  toc_json   TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  UNIQUE (novel_id, version)
);

CREATE TABLE IF NOT EXISTS episodes (
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

CREATE TABLE IF NOT EXISTS episode_versions (
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

CREATE INDEX IF NOT EXISTS idx_episodes_novel ON episodes(novel_id, position);
CREATE INDEX IF NOT EXISTS idx_ep_versions_episode ON episode_versions(episode_id, version);
`,
  // 6: バックアップ状態を novels テーブルに追加
  `
ALTER TABLE novels ADD COLUMN last_backup_metadata_at TEXT;
ALTER TABLE novels ADD COLUMN last_backup_all_at TEXT;
ALTER TABLE novels ADD COLUMN backup_episode_count INTEGER NOT NULL DEFAULT 0;
`,
  // 7: 通知テーブルを作成
  `
CREATE TABLE IF NOT EXISTS notifications (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id   INTEGER NOT NULL,
  type      TEXT NOT NULL,
  title     TEXT NOT NULL,
  message   TEXT,
  novel_key TEXT,
  read      INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(user_id, read);
`,
  // 8: バックアップスケジューラ設定テーブル
  `
CREATE TABLE IF NOT EXISTS backup_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`,
  // 9: 旧コードでバックアップ済み(episodes あり)だがバックアップ状態列が未設定の作品を補完
  `
UPDATE novels SET
  backup_episode_count = (SELECT COUNT(*) FROM episodes e WHERE e.novel_id = novels.id),
  last_backup_all_at = COALESCE(
    last_backup_all_at,
    (SELECT MAX(e.created_at) FROM episodes e WHERE e.novel_id = novels.id)
  ),
  last_backup_metadata_at = COALESCE(
    last_backup_metadata_at,
    last_checked_at,
    (SELECT MAX(e.created_at) FROM episodes e WHERE e.novel_id = novels.id)
  )
WHERE last_backup_all_at IS NULL
  AND EXISTS (SELECT 1 FROM episodes e WHERE e.novel_id = novels.id);
`,
  // 10: 本文が空/改行なしで保存された旧バージョンを破棄し、該当作品を次回バックアップで再取得させる
  //     (なろう新マークアップで本文が空、ハーメルンで改行消失していた不具合の救済)
  `
UPDATE novels SET last_backup_all_at = NULL
WHERE id IN (
  SELECT e.novel_id FROM episodes e JOIN episode_versions v ON v.episode_id = e.id
  JOIN novels n ON n.id = e.novel_id
  WHERE length(v.body_html) = 0 OR (n.site = 'hameln' AND instr(v.body_html, char(10)) = 0)
);
DELETE FROM episode_versions
WHERE length(body_html) = 0
   OR (instr(body_html, char(10)) = 0
       AND episode_id IN (SELECT e.id FROM episodes e JOIN novels n ON n.id = e.novel_id WHERE n.site = 'hameln'));
`,
  // 11: 元サイトでの最新話更新日時 novels.source_updated_at を追加。
  //     話ごとの日時 "YYYY/MM/DD HH:MM"(JST) を ISO 8601 (UTC) へ正規化し、空文字は NULL にして最大値を作品へ反映する。
  //     旧スクレイパーが保存した作者 "Unknown"(取得失敗)と、ハーメルンのタイトル末尾 " - ハーメルン" も補正する
  `
ALTER TABLE novels ADD COLUMN source_updated_at TEXT;

UPDATE episodes SET
  site_published_at = strftime('%Y-%m-%dT%H:%M:%fZ', replace(site_published_at, '/', '-') || ':00', '-9 hours')
WHERE site_published_at GLOB '[0-9][0-9][0-9][0-9]/[0-9][0-9]/[0-9][0-9] [0-9][0-9]:[0-9][0-9]';
UPDATE episodes SET
  site_updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', replace(site_updated_at, '/', '-') || ':00', '-9 hours')
WHERE site_updated_at GLOB '[0-9][0-9][0-9][0-9]/[0-9][0-9]/[0-9][0-9] [0-9][0-9]:[0-9][0-9]';
UPDATE episodes SET site_published_at = NULL WHERE site_published_at = '';
UPDATE episodes SET site_updated_at = NULL WHERE site_updated_at = '';

UPDATE novels SET source_updated_at = (
  SELECT MAX(COALESCE(e.site_updated_at, e.site_published_at)) FROM episodes e
  WHERE e.novel_id = novels.id AND e.removed_at IS NULL
);

UPDATE novels SET author = '' WHERE author = 'Unknown';
UPDATE novels SET title = substr(title, 1, length(title) - 8) WHERE site = 'hameln' AND title LIKE '% - ハーメルン';
`,
  // 12: ユーザーごとの既読管理(話単位)
  `
CREATE TABLE IF NOT EXISTS reading_progress (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  site        TEXT NOT NULL,
  novel_key   TEXT NOT NULL,
  episode_key TEXT NOT NULL,
  read_at     TEXT NOT NULL,
  PRIMARY KEY (user_id, site, novel_key, episode_key)
);

CREATE INDEX IF NOT EXISTS idx_reading_progress_novel ON reading_progress(user_id, site, novel_key, read_at DESC);
`,
  // 13: source_updated_at を「最新話の公開日時」に変更(改稿日時で並び順が変わらないようにする)
  `
UPDATE novels SET source_updated_at = (
  SELECT MAX(COALESCE(e.site_published_at, e.site_updated_at)) FROM episodes e
  WHERE e.novel_id = novels.id AND e.removed_at IS NULL
);
`,
  // 14: ユーザーごとの広告ブロックリスト(プリセットは初回 GET で遅延投入、カスタムは preset_key が NULL)
  `
CREATE TABLE IF NOT EXISTS user_blocklists (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  preset_key TEXT,
  name       TEXT NOT NULL,
  url        TEXT NOT NULL,
  enabled    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(user_id, url)
);
CREATE INDEX IF NOT EXISTS idx_user_blocklists_user ON user_blocklists(user_id);
`,
  // 15: カクヨムの本文保存時に話タイトルではなく作品名(h1)を保存していた不具合の救済。
  //     本文が変わらないと再保存されないため、話一覧のタイトルで補正する
  `
UPDATE episode_versions SET title = (SELECT e.title FROM episodes e WHERE e.id = episode_versions.episode_id)
WHERE episode_id IN (SELECT e.id FROM episodes e JOIN novels n ON n.id = e.novel_id WHERE n.site = 'kakuyomu');
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
