# 02. サーバー:認証・ユーザー・設定・API 一覧

## 認証

- Cookie 名 `nb_sid`、`httpOnly`, `SameSite=Lax`, `secure = COOKIE_SECURE`, 有効期限 30 日(アクセス時にスライド延長不要、固定でよい)。
- セッション ID は `crypto.randomBytes(32).toString('base64url')`。DB には **SHA-256 ハッシュ**を保存。
- ログイン失敗は一律 `401 {error:"invalid_credentials"}`。簡易レート制限:同一 IP で 1 分 10 回まで(メモリ上で可)。
- CSRF 対策:状態変更系 (POST/PUT/PATCH/DELETE) は `Content-Type: application/json` 必須 + `Origin` ヘッダがあればホストと一致を確認。
- middleware
  - `loadSession`:Cookie からユーザーを解決し `req.user = {id, username, role}`。
  - `requireAuth`:未ログインは `401`。
  - `requireAdmin`:`role !== 'admin'` は `403`。
- `/proxy/*` も `requireAuth` 対象(未ログインは 401 のプレーンテキスト)。

## 初回セットアップ

- `GET /api/auth/status` → `{ setupRequired: boolean, user: User | null }`
- `POST /api/auth/setup` `{username, password}` … ユーザーが 0 件の時のみ成功。admin を作成しログイン状態にする。1 件以上あれば `409`。

## バリデーション

- username: `^[a-zA-Z0-9_\-]{3,32}$`
- password: 8〜128 文字
- 入力は zod で検証し、不正は `400 {error:"validation_error", details}`。

## API 一覧

すべて JSON。エラーは `{ error: string, message?: string }`。

### auth
| Method | Path | 権限 | 説明 |
|---|---|---|---|
| GET | /api/auth/status | 公開 | setupRequired, user |
| POST | /api/auth/setup | 公開(0件時のみ) | 初期 admin 作成 |
| POST | /api/auth/login | 公開 | `{username,password}` |
| POST | /api/auth/logout | auth | |
| POST | /api/auth/password | auth | `{currentPassword,newPassword}` 自分のパスワード変更 |

### users(admin)
| GET | /api/users | 一覧 |
| POST | /api/users | `{username,password,role}` |
| PATCH | /api/users/:id | `{role?, password?}` |
| DELETE | /api/users/:id | 自分自身と最後の admin は削除不可(409) |

### settings
| GET | /api/settings | admin | 全設定 |
| PUT | /api/settings | admin | 部分更新。保存後 scheduler を再スケジュール |

設定キーは [05_backup.md](05_backup.md) 参照。

### その他
| GET | /api/health | 公開 | 死活確認 |

### live(auth) — リーダーモード用
| GET | /api/live/sites | 対応サイト一覧(`hosts`, `defaultHost`)。ブラウズモードが使用 |
| GET | /api/live/resolve?url=... | 任意 URL(元サイト URL or `/proxy/...` パス)→ `{site, novelKey, episodeKey?}` or 404 |
| GET | /api/live/:site/novels/:novelKey | `NovelInfo`(+ `bookmarked: boolean`) |
| GET | /api/live/:site/novels/:novelKey/episodes/:episodeKey | `EpisodeContent` + 前後話 ID |

ライブ取得結果はメモリ LRU キャッシュ(TTL 5 分、最大 200 件)。

### bookmarks(auth, 自分の分のみ)
| GET | /api/bookmarks | 一覧(作品メタ、最終バックアップ日時、話数、未読数相当の情報) |
| POST | /api/bookmarks | `{site, novelKey}` or `{url}`。作品を `novels` に upsert し、未バックアップなら即時バックアップをキュー投入 |
| PATCH | /api/bookmarks/:id | `{note?, lastReadEpisodeKey?}` |
| DELETE | /api/bookmarks/:id | ブックマーク削除(バックアップデータは消さない) |

### backups(auth)
viewer は「自分がブックマーク中 or 過去にブックマークしていた」作品のみ閲覧可…は複雑なので **viewer はブックマーク中の作品のみ、admin は全作品** とする。
| GET | /api/backups/novels | 作品一覧(状態、話数、最終チェック、最終変更、エラー) |
| GET | /api/backups/novels/:id | 作品メタ + 目次(各話の版数、削除フラグ)+ メタ版履歴 |
| GET | /api/backups/novels/:id/episodes/:episodeId | 最新版本文 + 版一覧 `[{version, fetchedAt, siteUpdatedAt, contentHash}]` |
| GET | /api/backups/novels/:id/episodes/:episodeId/versions/:version | 指定版本文 |
| POST | /api/backups/novels/:id/run | 対象作品を即時バックアップ(viewer はブックマーク中のみ可) |
| DELETE | /api/backups/novels/:id | admin のみ。作品と全版を削除 |
| GET | /api/backups/runs | admin。実行履歴(直近 50) |
| POST | /api/backups/run | admin。全作品バックアップを即時実行 `{force?: boolean}` |
| GET | /api/backups/status | auth。`{running, currentNovel?, queueLength, nextRunAt}` |
| GET | /api/backups/novels/:id/export?format=txt|html | 最新版を 1 ファイルにまとめてダウンロード(任意・Phase 3 の余力で) |

`novels.id` は DB の整数 ID、`episodeId` は DB の `episodes.id`(整数)。

## 実装メモ(Phase 4: backups API の確定形)

アクセス制御: viewer は自分がブックマーク中の作品のみ(それ以外は存在を隠して 404)、admin は全作品。JSON はすべて camelCase。
- `GET /api/backups/novels` → `{novels:[{id, site, novelKey, title, author, url, siteStatus, isDeletedOnSite, createdAt, lastCheckedAt, lastChangedAt, lastError, episodeCount, removedCount, unfetchedCount, versionCount, bookmarked, queued}]}`(最終変更の新しい順)
- `GET /api/backups/novels/:id` → `{novel, meta, metaVersions:[{version, hash, fetchedAt, tocCount, meta}], episodes:[{id, episodeKey, position, title, chapter, publishedAt, siteUpdatedAt, removedAt, versionCount, lastFetchedAt}]}`(削除済みの話は末尾)
- `GET .../episodes/:episodeId[/versions/:version]` → `{novel, episode:{..., removedAt, prevEpisodeId, nextEpisodeId}, version:{version, contentHash, title, prefaceHtml, bodyHtml, afterwordHtml, siteUpdatedAt, fetchedAt}, versions:[{version, fetchedAt, siteUpdatedAt, contentHash}]}`。本文が未取得なら 404 `no_versions`。
- `POST .../novels/:id/run` `{force?}` → 202 `{queued, alreadyQueued}`(`force` は admin のみ有効)。`POST /api/backups/run` `{force?}`(admin)→ 202 `{started, runId}` / 実行中は 409。
- `GET /api/backups/status` → `{running, runningAll, currentNovel, queueLength, nextRunAt}`。`GET /api/backups/runs`(admin)→ `{runs:[{id, trigger, startedAt, finishedAt, status, novelsChecked, episodesFetched, versionsAdded, errors:[{novelId,message}]}]}`。
- `DELETE /api/backups/novels/:id`(admin)。`GET .../export?format=txt|html` は実装済み(最新版を 1 ファイル、Content-Disposition 付き)。
- 状態変更系は CSRF ガードにより `Content-Type: application/json` 必須(DELETE も body `{}` を付ける)。
