# 02. データモデル

SQLite(`node:sqlite`)。ファイルは `data/novel-backup.db`(WAL)。`PRAGMA user_version` で適用済みマイグレーション数を管理し、`server/src/db/migrations.ts` の配列に **末尾追記のみ** で変更する。

## テーブル(現行)

| テーブル | 主なカラム |
|---|---|
| `users` | `id`, `username`(UNIQUE), `password_hash`(bcrypt), `role`(`admin`/`viewer`), `created_at` |
| `sessions` | `id_hash`(トークンの SHA-256, PK), `user_id`(→users, CASCADE), `created_at`, `expires_at`。アプリの Bearer トークン |
| `novels` | `id`, `site`(`hameln`/`narou`/`kakuyomu`), `novel_key`, `title`, `author`, `url`, `created_at`。`UNIQUE(site, novel_key)`。全ユーザー共有 |
| `bookmarks` | `id`, `user_id`(→users, CASCADE), `novel_id`(→novels, CASCADE), `note`, `last_read_episode_key`, `created_at`。`UNIQUE(user_id, novel_id)` |
| `history` | `id`, `user_id`(→users, CASCADE), `site`, `novel_key`, `episode_key`(作品ページは `''`), `novel_title`, `episode_title`, `url`, `viewed_at`。`UNIQUE(user_id, site, novel_key, episode_key)`、索引 `(user_id, viewed_at DESC)`。作品/話のページ毎に 1 行(再閲覧は `viewed_at` 更新) |


## マイグレーション

1. 初期スキーマ
2. `episode_versions`, `episodes`, `novel_meta_versions`, `backup_runs`, `settings` を `DROP TABLE IF EXISTS`。`users` / `sessions` / `novels` / `bookmarks` のデータは保持される。

3. `history`(閲覧履歴)とその索引を追加。

既存 DB(v1/v2)は起動時に自動で最新へ上がる。
