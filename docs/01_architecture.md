# 01. アーキテクチャ

```
┌──────────── Browser / PWA (Vue3 + TS) ────────────┐
│  Login / Setup                                     │
│  Live: Browse(iframe→/proxy) / Reader(/api/live)   │
│  Bookmarks / Backups(版管理・差分) / Admin         │
└───────────────┬────────────────────────────────────┘
                │ same-origin (Cookie: nb_sid)
┌───────────────▼──────────── Express (TS) ──────────┐
│ middleware: session → requireAuth / requireAdmin   │
│ /api/auth  /api/users  /api/settings               │
│ /api/live  /api/bookmarks  /api/backups            │
│ /proxy/:site/*  (HTML書き換えProxy)                 │
│                                                    │
│ sites/  SiteAdapter (hameln / narou / kakuyomu)    │
│ http/   politeFetch (ホスト毎キュー・間隔・リトライ)│
│ backup/ BackupService + Scheduler                  │
│ db/     node:sqlite + マイグレーション              │
└───────────────┬────────────────────────────────────┘
                │
        data/novel-backup.db
```

## ディレクトリ構成(目標)

```
package.json                 # workspaces, dev/build/start/typecheck/test
tsconfig.base.json           # 共通 strict 設定
server/
  package.json
  tsconfig.json
  src/
    index.ts                 # 起動: DB初期化 → app生成 → scheduler開始 → listen
    app.ts                   # express app 組み立て(テストから import 可能に)
    config.ts                # env 読み込み(PORT, DATA_DIR, COOKIE_SECURE など)
    settings.ts              # 設定の既定値/zod 検証/getSettings(db)/updateSettings/onSettingsChanged フック
    db/
      index.ts               # DatabaseSync 生成、PRAGMA(WAL, foreign_keys)
      migrations.ts          # user_version ベースの順次マイグレーション
    auth/
      password.ts            # bcryptjs hash/verify
      session.ts             # セッション発行/検証/削除、middleware
    routes/
      auth.ts users.ts settings.ts live.ts bookmarks.ts backups.ts proxy.ts
    sites/
      types.ts               # SiteAdapter / NovelInfo / EpisodeContent 型
      index.ts               # adapters レジストリ、URL→(site, novelId, episodeId)解決
      hameln.ts narou.ts kakuyomu.ts
      sanitize.ts            # 本文 HTML のサニタイズ
      util.ts                # 日付(JST→UTC)等の共通処理
    http/
      errors.ts csrf.ts rateLimit.ts   # sendError/parseBody、CSRF ガード、ログインレート制限
      politeFetch.ts
      siteErrors.ts          # サイト系例外 → HTTP レスポンス変換
    live/
      service.ts             # ライブ取得の LRU キャッシュ
    backup/
      service.ts             # 作品1件のバックアップ処理
      scheduler.ts           # 定期実行ループ、手動実行、ロック
      hash.ts
      queue.ts               # 作品単位バックアップ投入口(scheduler を登録)
    proxy/
      rewrite.ts             # HTML/URL 書き換え
  test/                      # vitest
client/
  package.json
  tsconfig.json
  vite.config.ts
  src/
    main.ts router.ts App.vue
    api/                     # fetch ラッパーと型付き API 関数
    stores/auth.ts           # pinia
    views/ ...               # 06_client.md 参照
    components/ ...
shared/                      # (任意) server/client 共通の API 型。tsconfig paths ではなく相対 import で可
```

`shared/` を使う場合は workspace にせず、`server` と `client` から相対パスで型のみ import する(`import type`)。

## 技術選定

| 用途 | ライブラリ |
|------|-----------|
| サーバー実行 (dev) | `tsx watch` |
| サーバービルド | `tsc` → `server/dist`、`node dist/index.js` で起動 |
| HTTP | `express` (4.x のまま), `cookie-parser` |
| DB | `node:sqlite` (`DatabaseSync`) — `--no-warnings` で ExperimentalWarning を抑制 |
| パスワード | `bcryptjs` |
| HTML パース | `cheerio` |
| HTML サニタイズ | `sanitize-html` |
| 差分 | `diff` (クライアント側で使用) |
| バリデーション | `zod` |
| テスト | `vitest` (server) |
| クライアント | `vue`, `vue-router`, `pinia`, `vite`, `vite-plugin-pwa`, `vue-tsc` |

外部 HTTP は Node 組み込み `fetch` を使う(axios 等は入れない)。

## 設定 (環境変数)

| 変数 | 既定 | 説明 |
|------|------|------|
| `PORT` | 3000 | |
| `DATA_DIR` | `<repo>/data` | DB 置き場 |
| `COOKIE_SECURE` | `false` | HTTPS 運用時 `true` |
| `USER_AGENT` | `novel-backup/0.1 (personal use)` を含む一般的なブラウザ UA | 外部取得時の UA |

## スクリプト(ルート package.json)

- `npm run dev` … server(tsx watch) と client(vite) を並行起動(既存どおり)
- `npm run build` … client と server の両方をビルド
- `npm start` … ビルド済み server を起動(client/dist を同一 origin 配信)
- `npm run typecheck` … `tsc --noEmit -p server` + `vue-tsc --noEmit -p client`
- `npm test` … server の vitest
