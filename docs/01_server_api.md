# 01. サーバー

Node.js >= 26 / TypeScript / Express 5 / `node:sqlite` / zod / bcryptjs。API 専用(静的配信・SPA fallback なし。未定義のパスは `404 {"error":"not_found"}`)。

```
server/src/
  index.ts          起動(DB を開く、期限切れトークン掃除、listen)
  app.ts            createApp({ db }): ルーティング・エラーハンドラ
  config.ts         PORT, DATA_DIR
  sites.ts          URL 解決のみ(resolveUrl / novelUrl / isSiteId)
  auth/             password(bcrypt), session(トークン発行・検証、requireAuth/requireAdmin)
  db/               openDb, migrations
  http/             errors(sendError/parseBody/ah), rateLimit
  routes/           auth, bookmarks, history, users
```

## 設定(環境変数)

| 変数 | 既定 | 内容 |
|---|---|---|
| `HOST` | `127.0.0.1` | 待ち受けアドレス(同一マシンのリバースプロキシ前提。[05_deployment.md](05_deployment.md)) |
| `PORT` | `3000` | 待ち受けポート |
| `SETUP_TOKEN` | なし | 初回管理者作成に必要。未設定だと `/api/auth/setup` は `403 setup_disabled` |
| `DATA_DIR` | `<repo>/data` | DB 置き場。`novel-backup.db` を作成 |

## 認証

- `Authorization: Bearer <token>` のみ。トークンは `sessions` テーブルに SHA-256 ハッシュで保存、有効期限 90 日。
- Cookie は読まない・設定しない。CSRF 対策は不要(ブラウザが自動付与する資格情報がない)。
- `POST /api/auth/token` は IP 毎に 10 回/分 + ユーザー名毎の失敗ロックアウト(5 回で 1 分、倍々で上限 15 分)。`/setup`・`/password` にもレート制限。詳細は [05_deployment.md](05_deployment.md)。
- 500 は常に `{ "error": "internal_error" }`(詳細はサーバーログのみ)。

エラー形式: `{ "error": "<code>", "message"?: string }`。入力不正は `400 validation_error`(`details` に zod issues)。

## エンドポイント

### 認証 `/api/auth`

| メソッド/パス | 認証 | 内容 |
|---|---|---|
| `GET /api/health` | 不要 | `{ ok, name, version }` |
| `GET /api/auth/status` | 不要 | `{ setupRequired, setupEnabled, user }`(`setupEnabled` はサーバーに `SETUP_TOKEN` があるか)。`user` はトークンが有効なときのみ(`{id, username, role}`)、無効/なしは `null` |
| `POST /api/auth/setup` | 不要 | ユーザーが 0 人のときのみ。`{ username, password, setupToken }`(`setupToken` は環境変数 `SETUP_TOKEN` と一致が必要)で最初の admin を作成し **`201 { token, expiresAt, user }`**。既にユーザーがいれば `409 already_setup`、`SETUP_TOKEN` 未設定は `403 setup_disabled`、トークン不一致/欠落は `403 invalid_setup_token`、超過は `429`。(body の `token: true` は受け付けるが、常にトークンを返す) |
| `POST /api/auth/token` | 不要 | `{ username, password }` → `{ token, expiresAt, user }`。失敗 `401 invalid_credentials`、超過・ロックアウト中は `429 { error: "too_many_requests", retryAfter }`(`Retry-After` ヘッダ付き) |
| `POST /api/auth/logout` | 必要 | 使用中のトークンを失効 |
| `POST /api/auth/password` | 必要 | `{ currentPassword, newPassword }`。現在のトークンは維持し、同ユーザーの他トークンは失効。現パスワード不一致は `401 invalid_credentials` |

制約: ユーザー名 `^[a-zA-Z0-9_-]{3,32}$`、パスワード 8〜128 文字。

### ブックマーク `/api/bookmarks`(認証必須・自分の分のみ)

| メソッド/パス | 内容 |
|---|---|
| `GET /` | `{ bookmarks: [...] }`。クエリ `q`(タイトル/作者/サイト id・日本語名の部分一致、大小無視)、`sort=added|updated|title|site`(既定 `added`。`updated` は当面 `added` と同じ)、`order=asc|desc`(既定 `desc`)。不正値は `400 validation_error` |
| `GET /lookup?url=` | `{ bookmarked, bookmarkId }`。話ページ URL でも作品で判定。作品/話ページ以外は `{ false, null }`。`url` 無しは 400 |
| `POST /` | `{ url, title, author? }` または `{ site, novelKey, title, author? }`。**`title` 必須**(アプリが表示中のページから取得して送る)。サーバーはサイトへアクセスしない。`url` は `resolveUrl` で作品に解決(話ページ URL も可)。作成 `201 { bookmark, created: true }`、登録済み `200 { bookmark, created: false }`(既存作品のタイトル/著者が空のときのみ補完)。作品/話ページでない URL は `400 not_a_novel_page` |
| `PATCH /:id` | `{ note?, title?, lastReadEpisodeKey? }`(`title` は共有の作品タイトルを更新) |
| `DELETE /:id` | 削除(作品行は残る) |

ブックマーク DTO: `id, novelId, site, novelKey, title, author, url, note, lastReadEpisodeKey, createdAt`。

### 閲覧履歴 `/api/history`(認証必須・自分の分のみ)

履歴 DTO: `id, site, novelKey, episodeKey, novelTitle, episodeTitle, url, viewedAt`(作品ページの閲覧は `episodeKey: ""`)。

| メソッド/パス | 内容 |
|---|---|
| `POST /` | `{ url, novelTitle?, episodeTitle?, viewedAt? }`。`resolveUrl` で site/novelKey/episodeKey を確定し (ユーザー, site, novelKey, episodeKey) で upsert。**`200 { history }`**。再閲覧は `viewed_at`/`url` を更新(`viewedAt` が古くても巻き戻さない、未来は現在に丸める)、タイトルは空でない値のときだけ上書き。作品ページの `episodeTitle` は無視。作品/話ページ以外は `400 not_a_novel_page`。`viewedAt` はオフライン中に溜めた閲覧の送信用(ISO 8601) |
| `GET /?view=episode|novel&q=&limit=&offset=` | `{ view, history: [...] }`。`view=episode`(既定): 行そのまま `viewed_at` の新しい順。`view=novel`: 作品毎(site+novelKey)に 1 件。代表は**最後に読んだ話**(話の閲覧が無ければ作品ページ行)で、`id/episodeKey/episodeTitle/url` はその行のもの、`novelTitle` は空でなければ代表行、無ければ作品内の非空タイトル。`episodeCount` = 閲覧した話数(作品ページ行は数えない)、`viewedAt` = 作品内の最終閲覧日時。新しい最終閲覧順。`q` は作品名/話タイトルの部分一致(作品毎は作品内のどれかの行が一致すれば作品を残す)。`limit` 1〜500(既定 100)、`offset` ≥ 0 |
| `DELETE /:id` | 1 行削除。他人の行/無い行は 404 |
| `DELETE /?site=&novelKey=` | 作品単位で削除(両方必須、片方だけは 400)。`{ ok, deleted }` |
| `DELETE /` | 自分の履歴を全消去。`{ ok, deleted }` |

### 広告ブロックリスト `/api/blocklists`(認証必須・自分の分のみ)

アプリの内蔵サイトビューアで「ドメイン一致で広告を遮断する」ための DNS 形式ブロックリストの URL を管理する。**サーバーはこれらの URL に一切アクセスしない**(ダウンロードと解析は端末のみ。SSRF の面を持たない)。端末の DNS は変更しない。

リスト DTO: `id, presetKey(プリセットは文字列、カスタムは null), name, url, enabled`。

| メソッド/パス | 内容 |
|---|---|
| `GET /` | `{ lists: [...] }`。初回(およびプリセット追加リリース後)に未投入のプリセットを遅延投入する(既存行の `enabled` は変更しない)。プリセット: `adguard-dns`(既定で有効。これだけ)、`peter-lowe`、`oisd-small`、`stevenblack`(いずれも既定は無効) |
| `POST /` | `{ name, url }` → `201 { list }`(有効で作成)。`name` は trim 後 1〜64 文字。`url` は https のみ・2048 文字以内・認証情報なし・IP リテラル/`localhost`/`.local`/ドット無しホストは不可(`400 validation_error`)。カスタムは 1 ユーザー 20 件まで(超過 `400 blocklist_limit`)。同一 URL は `409 blocklist_duplicate`(プリセットの URL も含む) |
| `PATCH /:id` | `{ enabled: boolean }` → `{ list }`。プリセット/カスタムとも可 |
| `DELETE /:id` | カスタムのみ `{ ok }`。プリセットは `400 blocklist_preset_undeletable` |

`:id` は 10 進整数のみ(不正は `400 validation_error`)。他ユーザーの行/無い行は `404 not_found`。

### ユーザー `/api/users`(admin のみ。未認証 401、viewer 403)

| メソッド/パス | 内容 |
|---|---|
| `GET /` | `{ users: [{id, username, role, createdAt}] }` |
| `POST /` | `{ username, password, role }` → `201 { user }`。重複 `409 username_taken` |
| `PATCH /:id` | `{ role?, password? }`。最後の admin の降格は `409 last_admin`。パスワードを変えるとそのユーザーの全トークンを失効 |
| `DELETE /:id` | 自分自身は `409 cannot_delete_self`、最後の admin は `409 last_admin` |

## URL 解決(`sites.ts`)

純粋関数のみ。`resolveUrl(url)` は次の URL から `{ site, novelKey, episodeKey? }` を返す(それ以外は `null`)。

| サイト | 作品 | 話 |
|---|---|---|
| narou | `https://ncode.syosetu.com/n1234ab/`(novelKey は小文字化) | `.../n1234ab/12/` |
| kakuyomu | `https://kakuyomu.jp/works/123` | `.../works/123/episodes/456` |
| hameln | `https://syosetu.org/novel/298/`(旧形式 `/?mode=ss_detail&nid=298` も可) | `.../novel/298/12.html` |

`novelUrl(site, novelKey)` が正規の作品 URL を組み立てる。

## 開発

```bash
npm run dev        # tsx watch (server)
npm run typecheck
npm test           # vitest + supertest(メモリ DB)
```
