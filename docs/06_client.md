# 06. クライアント (Vue 3 + TS + PWA)

## 基本

- `<script setup lang="ts">`、Composition API、状態管理は pinia(`auth` ストアは必須、他は必要に応じて)。
- UI ライブラリは使わず素の CSS(既存 App.vue の配色 `#2b6b47` を踏襲)。CSS 変数でライト/ダークを用意。
- レスポンシブ:幅 768px 以上はサイドバー、未満は下部タブバー。リーダー画面はナビを隠して全画面寄り。
- API ラッパー `src/api/client.ts`:`fetch` + `credentials:'same-origin'` + JSON。`401` を受けたら auth ストアをクリアして `/login` へ。

## ルーティングとガード

| Path | 画面 | 権限 |
|------|------|------|
| `/setup` | 初期 admin 作成(setupRequired の時のみ。それ以外は `/` へ) | 公開 |
| `/login` | ログイン | 公開 |
| `/` | ホーム:ブックマーク更新状況のサマリ(最近更新された作品、バックアップ状態) | auth |
| `/live` | ブラウズモード:サイト選択タブ(ハーメルン/なろう/カクヨム)+ iframe + ツールバー(戻る/進む/再読込/URL 入力/ブックマーク/リーダーで開く) | auth |
| `/live/:site/:novelKey` | リーダー:作品情報+目次(ライブ) | auth |
| `/live/:site/:novelKey/:episodeKey` | リーダー:本文(ライブ)。前後話、目次へ戻る | auth |
| `/bookmarks` | ブックマーク一覧(メモ編集、削除、ライブで開く、バックアップで開く、今すぐバックアップ) | auth |
| `/backups` | バックアップ作品一覧(検索・サイト絞り込み) | auth |
| `/backups/:novelId` | 作品メタ・メタ版履歴・目次(版数バッジ、削除済みバッジ) | auth |
| `/backups/:novelId/episodes/:episodeId` | 本文 + 版セレクタ + 「差分を見る」 | auth |
| `/admin/settings` | バックアップ設定、手動全体実行、現在の状態/次回実行時刻 | admin |
| `/admin/users` | ユーザー管理 | admin |
| `/admin/runs` | 実行履歴(エラー詳細展開) | admin |
| `/account` | パスワード変更、ログアウト | auth |

ルートガード:起動時に `/api/auth/status` を 1 回取得 → setupRequired なら `/setup`、未ログインなら `/login?redirect=...`、`meta.admin` で admin 判定。

## リーダー共通コンポーネント

`EpisodeReader.vue`(ライブとバックアップで共用):
- props:`title, prefaceHtml?, bodyHtml, afterwordHtml?`
- 本文 HTML 中の `img src` を `/proxy/img?url=<encoded>` に置換して表示(`v-html`。サーバー側でサニタイズ済みだが、クライアントでも `<script>` 等が無い前提で可)。
- 表示設定(localStorage):文字サイズ、行間、フォント(明朝/ゴシック)、テーマ(ライト/セピア/ダーク)、**縦書き切替**(`writing-mode: vertical-rl`)。
- 読了位置:ブックマーク済み作品で話を開いたら `PATCH /api/bookmarks/:id {lastReadEpisodeKey}`。

`DiffView.vue`:2 版のテキスト差分を追加=緑/削除=赤で行単位表示。

## ブラウズモード詳細

- iframe `src="/proxy/{site}/{defaultHost}/"`。サイト毎の初期ページ:
  - ハーメルン `syosetu.org/` 、なろう `yomou.syosetu.com/`、カクヨム `kakuyomu.jp/`
- URL 入力欄に元サイト URL を貼ると `/proxy/...` に変換して遷移(対応外ホストはエラー表示)。
- iframe `load` で `contentWindow.location` を読み、`/api/live/resolve` で作品判定 → ブックマーク状態とボタン表示。
- iframe には `sandbox="allow-same-origin allow-forms allow-popups"`(scripts は許可しない)。

## PWA

- `vite-plugin-pwa`(generateSW)継続。`navigateFallbackDenylist: [/^\/api\//, /^\/proxy\//]`。
- runtimeCaching:
  - `/api/backups/novels/*` GET → `NetworkFirst`(cacheName `backups`、オフライン時は最後に見た内容を表示)
  - `/proxy/img` → `CacheFirst`(最大 500 件、30 日)
  - `/api/auth`, `/api/live`, `/proxy/{site}` はキャッシュしない
- アイコンは既存 `public/pwa-*.png` を流用。

## 実装メモ(Phase 4)

- 追加: `views/Backups.vue`, `BackupNovel.vue`, `BackupEpisode.vue`(`?v=N` で版指定、差分は `DiffView.vue`)、`AdminSettings.vue`, `AdminRuns.vue`、`composables/backupPoll.ts`(今すぐバックアップ後に status をポーリングして完了時に再読込)、Home はサマリ(状態・最近更新・エラー作品)、Bookmarks に「今すぐバックアップ」。
- `DiffView.vue`: `diffLines` で行差分、削除+追加が隣接する塊は同位置の行ペアに `diffChars` を適用して強調。変更のない行は前後 3 行を残して折りたたみ(「全文表示」で解除)。
- PWA runtimeCaching: `/api/backups/novels*` の GET は NetworkFirst(`backups`、5 秒タイムアウト)、`/proxy/img` は CacheFirst(`proxy-img`、500 件 / 30 日)。
