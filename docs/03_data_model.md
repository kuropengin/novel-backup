# 03. データモデル (SQLite)

`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;`
日時はすべて ISO8601 文字列(UTC)で保存。マイグレーションは `PRAGMA user_version` で管理し、`migrations.ts` の配列に SQL を追記していく。

```sql
CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin','viewer')),
  created_at    TEXT NOT NULL
);

CREATE TABLE sessions (
  id_hash    TEXT PRIMARY KEY,           -- sha256(session id)
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL                    -- JSON 文字列
);

-- 作品(全ユーザー共有)
CREATE TABLE novels (
  id              INTEGER PRIMARY KEY,
  site            TEXT NOT NULL CHECK (site IN ('hameln','narou','kakuyomu')),
  novel_key       TEXT NOT NULL,         -- hameln:数値ID / narou:ncode小文字 / kakuyomu:workId
  title           TEXT NOT NULL DEFAULT '',
  author          TEXT NOT NULL DEFAULT '',
  url             TEXT NOT NULL,
  site_status     TEXT NOT NULL DEFAULT 'unknown', -- ongoing|completed|unknown
  is_deleted_on_site INTEGER NOT NULL DEFAULT 0,   -- 404 等で消えたと判断
  created_at      TEXT NOT NULL,
  last_checked_at TEXT,
  last_changed_at TEXT,                  -- 何らかの新版が追加された最終日時
  last_error      TEXT,
  UNIQUE (site, novel_key)
);

-- 作品メタ(タイトル/あらすじ/作者/タグ等)の版
CREATE TABLE novel_meta_versions (
  id         INTEGER PRIMARY KEY,
  novel_id   INTEGER NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
  version    INTEGER NOT NULL,           -- 1 始まり
  hash       TEXT NOT NULL,
  meta_json  TEXT NOT NULL,              -- NovelMeta (目次を除く)
  toc_json   TEXT NOT NULL,              -- TocEntry[] のスナップショット
  fetched_at TEXT NOT NULL,
  UNIQUE (novel_id, version)
);

CREATE TABLE episodes (
  id            INTEGER PRIMARY KEY,
  novel_id      INTEGER NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
  episode_key   TEXT NOT NULL,           -- サイト上の話ID
  position      INTEGER NOT NULL,        -- 現在の目次上の順番(0始まり)
  title         TEXT NOT NULL,
  chapter       TEXT,                    -- 章タイトル
  site_published_at TEXT,
  site_updated_at   TEXT,                -- 目次から得た更新日時(差分判定用)
  removed_at    TEXT,                    -- 目次から消えた日時。復活したら NULL に戻す
  created_at    TEXT NOT NULL,
  UNIQUE (novel_id, episode_key)
);

CREATE TABLE episode_versions (
  id              INTEGER PRIMARY KEY,
  episode_id      INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  version         INTEGER NOT NULL,      -- 1 始まり
  content_hash    TEXT NOT NULL,         -- sha256(正規化した title+preface+body+afterword)
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
  trigger     TEXT NOT NULL,             -- schedule|manual|bookmark|novel
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  status      TEXT NOT NULL,             -- running|success|partial|failed
  novels_checked   INTEGER NOT NULL DEFAULT 0,
  episodes_fetched INTEGER NOT NULL DEFAULT 0,
  versions_added   INTEGER NOT NULL DEFAULT 0,
  errors_json TEXT NOT NULL DEFAULT '[]' -- [{novelId, message}]
);

CREATE INDEX idx_episodes_novel ON episodes(novel_id, position);
CREATE INDEX idx_ep_versions_episode ON episode_versions(episode_id, version);
CREATE INDEX idx_bookmarks_user ON bookmarks(user_id);
```

## 補足

- 起動時と 1 時間毎に期限切れセッションを削除。
- 本文は圧縮せずに TEXT 保存(数千話規模でも問題ない想定)。将来必要になれば `body_html` を gzip BLOB 化するマイグレーションを追加。
- 「最新版」は `episode_versions` の `MAX(version)`。
