# 07. 実装計画(サブエージェント向け)

各フェーズは前フェーズ完了後に着手する(同一ワークツリーで順次実行)。
**全フェーズ共通ルール**

- 着手前に `docs/` 全体を読む。設計と異なる判断が必要になったら、実装した上で該当 doc を更新し、最終報告で明記する。
- TypeScript は `strict: true`。`any` は外部 JSON パース境界のみ許可。
- 依存追加は Phase 1 で一括。後続フェーズで追加が必要な場合は `npm i <pkg> -w server|client` で追加し報告する。
- 各フェーズ終了時に `npm run typecheck` と `npm test` が通ること(Phase 1 以降)。
- git commit はしない(親エージェントがレビュー後に判断)。
- Windows 環境(PowerShell / Git Bash)。パス区切りに依存しないコードにする。

---

## Phase 1 — TS 化と基盤(担当: sonnet)

1. ルートに `tsconfig.base.json`、`server/tsconfig.json`、`client/tsconfig.json`(+ `tsconfig.node.json` 等必要に応じ)。
2. 依存インストール(01_architecture.md の表すべて + `@types/express`, `@types/cookie-parser`, `@types/sanitize-html`, `@types/diff`(必要なら), `typescript`, `tsx`, `vitest`, `vue-tsc`, `pinia`)。
3. server を TS 化:`index.ts` / `app.ts` / `config.ts`。既存の静的配信 + SPA fallback を維持(`/api` と `/proxy` は fallback 対象外で 404 JSON)。`server/package.json` の scripts:`dev`(tsx watch), `build`(tsc), `start`(node --no-warnings dist/index.js), `typecheck`, `test`。
4. DB 層(`db/index.ts`, `db/migrations.ts`)— 03_data_model.md の全テーブルを migration 1 として作成。
5. 認証・ユーザー・設定 API(02_server.md の auth / users / settings)。設定のスキーマと既定値は 05_backup.md。
6. client を TS 化:`main.ts`, `router.ts`, `vite.config.ts`、pinia auth ストア、API ラッパー、ルートガード、レイアウト(サイドバー/下部タブ)。
   画面:`/setup`, `/login`, `/account`, `/admin/users`, `/` (仮ホーム)。他のルートは「準備中」プレースホルダで登録だけしておく。
7. ルート scripts:`dev`, `build`(client + server), `start`, `typecheck`, `test`。
8. テスト:auth(setup→login→status→logout、viewer が admin API で 403)を supertest 相当で(`supertest` を追加してよい)。DB はテスト毎に `:memory:` か一時ディレクトリ。

**完了条件**:`npm run dev` で初回 setup → ログイン → ユーザー作成 → viewer でログインし admin メニューが出ないことが確認できる。typecheck/test/build 成功。

## Phase 2 — サイトアダプタ(担当: sonnet)

1. `http/politeFetch.ts`(04 の仕様。間隔は settings から取得する関数を注入できるように)。
2. `sites/types.ts`, `sites/sanitize.ts`, `sites/hameln.ts`, `sites/narou.ts`, `sites/kakuyomu.ts`, `sites/index.ts`(`getAdapter(site)`, `resolveUrl(url) → {site, novelKey, episodeKey?}`。`/proxy/{site}/{host}/...` 形式のパスも解決可能に)。
3. **WebFetch / 実リクエストで各サイトの現行 DOM を確認してからセレクタを決める**。連載・短編・章あり作品をそれぞれ最低 1 作品で確認。
4. テスト:
   - `parseUrl` / `resolveUrl` の単体テスト(各サイトの各種 URL 形式)
   - パーサは「HTML 文字列 → 結果」の純関数に分離し、`server/test/fixtures/` に **最小化した** HTML(本文は数行に削る)を置いてテスト。
   - 実ネットワークを叩く smoke テストは `LIVE_TEST=1` の時のみ実行。
5. `scripts/try-adapter.ts`(`npx tsx server/scripts/try-adapter.ts <url>` で NovelInfo と 1 話目を表示)を用意。

**完了条件**:3 サイトそれぞれで連載作品の目次・本文、短編の本文が `try-adapter` で取れる。テスト成功。

## Phase 3 — ライブ閲覧・Proxy・ブックマーク(担当: sonnet)

1. `proxy/rewrite.ts` と `routes/proxy.ts`(04 の Proxy 仕様。ホワイトリスト厳守)。
2. `routes/live.ts`(resolve / novels / episodes + LRU キャッシュ)。
3. `routes/bookmarks.ts`。ブックマーク追加時のバックアップ投入は、Phase 4 の scheduler がまだ無いので `backup/queue.ts` に `enqueueNovelBackup(novelId, trigger)` の no-op スタブ(ログ出力のみ)を置き、Phase 4 で差し替える。
4. client:`/live`(ブラウズ)、`/live/:site/:novelKey`、`/live/:site/:novelKey/:episodeKey`、`/bookmarks`、`EpisodeReader.vue`(表示設定・縦書き含む)。
5. テスト:rewrite の単体テスト(リンク書き換え、許可外ホスト、script 除去)、Proxy が許可外ホストを 400 で拒否すること。

**完了条件**:アプリ内で 3 サイトを回遊でき、作品ページでブックマーク → 一覧に出る。リーダーで本文を読める。

## Phase 4 — バックアップ・版管理・閲覧(担当: sonnet)

1. `backup/service.ts`, `backup/scheduler.ts`, `backup/hash.ts`(05 の仕様)。Phase 3 のスタブを本実装に差し替え。
2. `routes/backups.ts`(02 の backups API。viewer の閲覧制限に注意)。
3. client:`/backups`, `/backups/:novelId`, `/backups/:novelId/episodes/:episodeId`(版セレクタ・`DiffView.vue`)、`/admin/settings`、`/admin/runs`、ホームのサマリ。ブックマーク一覧に最終バックアップ日時と「今すぐバックアップ」。
4. PWA runtimeCaching(06 の PWA 節)。
5. テスト:`backupNovel` をフェイクアダプタで検証 —— 初回取得で v1、変更なしで版が増えない、本文変更で v2、目次から消えた話に removed_at、404 で is_deleted_on_site。scheduler の多重実行防止。

**完了条件**:ブックマークした作品が自動でバックアップされ、設定した間隔で再実行される。本文を書き換えたフェイク/手動 DB 操作で v2 ができ、UI で差分が見られる。

## Phase 5 — 仕上げ・検証(担当: haiku)

1. `README.md` をセットアップ・起動・運用(環境変数、バックアップの場所、HTTPS 運用時の注意、個人利用の注意)で書き直す。
2. `npm run typecheck`, `npm test`, `npm run build` を実行し、失敗があれば修正(大きな修正が必要なら修正せず報告)。
3. docs と実装の差異を一覧化して報告。
