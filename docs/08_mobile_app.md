# 08. Android ネイティブアプリ(直接閲覧 + お気に入り保存)

## 背景

- ハーメルンは Cloudflare のチャレンジにより、サーバーからの取得(Proxy・バックアップ)ができない。
- 実ブラウザエンジン(WebView)で利用者自身が閲覧すれば通常どおり表示できるため、**3 サイトを Proxy を通さず直接表示する Android アプリ**を作る。
- バックアップ機能(特にハーメルン)は一旦保留。本アプリは「直接閲覧」と「お気に入り保存」のみ。
- **自動取得・チャレンジ突破・指紋偽装などは一切行わない。** アプリは利用者が操作する通常のブラウザとして振る舞う。

## 決定事項

| 項目 | 決定 |
|---|---|
| 対象 | Android のみ |
| 構成 | 新ワークスペース `mobile/`:Capacitor 7 + Vue 3 + TS + Vite |
| サイト表示 | `cordova-plugin-inappbrowser`(Capacitor で利用可)の `_blank` WebView で**元サイトを直接表示** |
| お気に入りボタン | ページ読み込み完了(`loadstop`)時に `executeScript` で画面右下にフローティングボタンを注入。押すとページ内スクリプトがタイトル等を取得し `postMessage` でアプリへ通知 |
| 保存先 | **既存サーバーの DB**(`bookmarks` / `novels`)。Web 版と共有 |
| 通信 | `CapacitorHttp`(ネイティブ HTTP)を有効化し CORS を回避。認証は Bearer トークン |
| サーバー URL | アプリの設定画面で入力(例 `http://192.168.1.10:3000`)。`@capacitor/preferences` に保存 |

## 画面(mobile)

1. **設定 / ログイン**:サーバー URL、ユーザー名、パスワード → `POST /api/auth/token` でトークン取得し保存。ログアウト。
2. **ホーム**:
   - サイトボタン 3 つ(ハーメルン `https://syosetu.org/`、なろう `https://yomou.syosetu.com/`、カクヨム `https://kakuyomu.jp/`)→ InAppBrowser で開く
   - お気に入り一覧(`GET /api/bookmarks`)。タップでその作品ページを InAppBrowser で開く。削除可。

## お気に入り保存の流れ

1. InAppBrowser の `loadstop` で注入スクリプトを実行:
   - ボタン(★)を `position:fixed` で右下に配置(既に存在すれば再注入しない)。
   - 押下時、ページ内で `{ url: location.href, title, author? }` を取得し `webkit.messageHandlers.cordova_iab.postMessage(JSON.stringify(...))` で送信。
2. アプリは `message` イベントで受信 → `POST /api/bookmarks { url, title, author? }`。
   - サーバーは `resolveUrl(url)` で `{site, novelKey}` を確定(話ページの URL でも作品に解決される)。作品/話ページでなければ 400 `not_a_novel_page`。
3. 結果を `executeScript` でページ内トースト表示(「保存しました」「登録済み」「作品ページではありません」「サーバーに接続できません」)。

### タイトル取得(注入スクリプト内、サイト別)

作品ページ・話ページの両方で**作品タイトル**を取る。セレクタは候補を順に試し、最後は `document.title` から ` - ハーメルン` 等のサイト名部分を除去したもの。

| サイト | 作品ページ | 話ページ |
|---|---|---|
| なろう | `.p-novel__title`, `h1` | パンくず/ヘッダの作品リンク(`.c-announce a` 等)、`document.title` の `作品名 - 話タイトル` 前半 |
| カクヨム | `h1` 内の作品タイトル(`__NEXT_DATA__` が読めればそこから) | `#contentMain-header-workTitle` 等、`document.title` の後半 `- 作品名 - カクヨム` |
| ハーメルン | `span[itemprop="name"]`, `h1` | `document.title` 等(**実 DOM 未検証**。取れなければ `document.title` を整形) |

なろう・カクヨムは実装時に実ページで確認する。ハーメルンは推測のため、取得できなかった場合も保存は行い、タイトルは後から Web 版/アプリで編集できるようにする。

## サーバー側の変更

1. **Bearer トークン認証**
   - `POST /api/auth/token { username, password }` → `{ token, user }`。トークンは既存 `sessions` テーブルを流用(有効期限 90 日)。ログイン失敗レート制限は login と共有。
   - `loadSession` は Cookie に加え `Authorization: Bearer <token>` を受け付ける。
   - CSRF ガード:Bearer で認証され Cookie を伴わないリクエストは Origin / Content-Type 検査をスキップ(Cookie 送信を伴わないため CSRF の対象外)。
   - `POST /api/auth/logout` は Bearer トークンも失効させる。
2. **ブックマーク**
   - `POST /api/bookmarks` に任意の `title`, `author` を追加。`title` が指定された場合は**サイトへの取得を行わず**その値で `novels` を作成/更新(既存作品のタイトルが空の場合のみ上書き)。
   - `PATCH /api/bookmarks/:id` で作品タイトルの手動修正を可能にする(`title` を受け付け `novels.title` を更新)— Web 版のブックマーク画面にも編集 UI を追加。
   - バックアップ保留中のため、`title` 付きで作成されたブックマークでは即時バックアップを投入しない(定期実行は管理設定の間隔に従う。止めたい場合は間隔 0)。
3. ブックマーク一覧のレスポンスに作品の元 URL(`url`)が含まれていること(アプリで開くため)。

## Android 固有

- `capacitor.config.ts`:`appId: "local.novelbackup.app"`, `appName: "小説ビューア"`, `plugins.CapacitorHttp.enabled = true`。
- LAN の HTTP サーバーへ接続するため `android:usesCleartextTraffic="true"`(個人利用前提。HTTPS 運用なら不要)。
- InAppBrowser オプション:`location=no,toolbar=yes,hidenavigationbuttons=no,zoom=no,hardwareback=yes`。戻るボタンでページ戻る、履歴が無ければ閉じる。
- ビルド:Android Studio(JDK・SDK 同梱)が必要。`npm run build -w mobile && npx cap sync android` → `cd mobile/android && gradlew assembleDebug`。

## 完了条件

- `npm run typecheck`, `npm test`, `npm run build` が通る(mobile を含む)。
- サーバーテスト:Bearer トークン発行/認証/失効、Bearer での POST が CSRF ガードを通る、Cookie なし・トークンなしは 401、`title` 付きブックマーク作成でアダプタが呼ばれない、`not_a_novel_page`。
- `npx cap sync android` が成功し `mobile/android` が生成される。SDK があれば debug APK をビルド。

## 実装メモ

- **トークン**: `POST /api/auth/token` は `{ token, expiresAt, user }` を返す。`createSession` に TTL 引数を追加して流用(90 日)。ログイン失敗レート制限は `/login` と同じ limiter を共有(`authenticate()` を共通化)。`req.authToken` / `req.authViaBearer` を `loadSession` が設定。Cookie があれば Cookie を優先、無ければ Bearer を見る。
- **CSRF**: `req.authViaBearer` かつ `nb_sid` Cookie が無いリクエストのみスキップ(Content-Type・Origin 検査とも)。Cookie 認証は従来どおり検査。
- **logout / password**: `req.authToken`(Cookie でも Bearer でも)を失効 / 維持する形に統一。
- **`not_a_novel_page`**: `POST /api/bookmarks` の `url` が解決できない場合のエラーコードを `unsupported_url` から `not_a_novel_page` に**変更**(Web 版のメッセージ表も更新)。
- **ブックマーク POST**: `title` 指定時はアダプタを呼ばず `novelUrl()` で URL を組み立てて作品を作成し、即時バックアップを投入しない。`title`/`author` は既存作品でも空の場合のみ補完。既存ブックマークがあれば従来どおり 200 / `created: false`。`title` 無しの従来動作(サイト取得 + 初回バックアップ投入)は不変。
- **PATCH `title`**: 1〜500 文字。`novels.title` は全ユーザー共有のため、他ユーザーの表示にも反映される(個人利用前提)。
- **タイトル抽出の確認結果**(2026-10 実ページ 1〜2 件で確認、取得は単発の通常 GET のみ):
  - なろう作品ページ: `.p-novel__title` が作品名、`.p-novel__author a` が作者。話ページでは `.p-novel__title` は**話タイトル**になるため、作品名はパンくずの `a[href="/<ncode>/"]` のテキスト(確認済み)。無ければ `document.title` から ` - 話タイトル` を除去。
  - カクヨム: 作品ページ `h1`(内の `a`)が作品名、話ページは `#contentMain-header-workTitle`(確認済み)。作者は `document.title` の `（作者）` から取得。`__NEXT_DATA__` は DOM で十分だったため使っていない。
  - ハーメルン: 未検証。`span[itemprop="name"]` 等 + 話ページでは `a[href="/novel/<id>/"]` のリンク文字列を推測で使用し、最後は `document.title` の整形。
  - 注入スクリプトを jsdom + 上記実ページ(および既存 fixture)で実行し、ボタン 1 個のみ(二重注入なし)・期待どおりのペイロードになることを確認。3 サイト以外のホストでは ★ を出さない。
- **メッセージ**: Android の InAppBrowser は `loadstop` 前に `window.webkit.messageHandlers.cordova_iab` を用意し、`postMessage` の引数は JSON 文字列(オブジェクト)である必要がある。`message` イベントの `data` にそのオブジェクトが入る。
- **戻るボタン**: `hardwareback=yes` で InAppBrowser 側が「戻れれば戻る、履歴が無ければ閉じる」を実装している(プラグインのソースで確認)ため、アプリ側の追加処理は不要。ホーム画面では Capacitor の `backButton` で設定画面→ホーム、ホームでは終了。
- **依存**: 設計に無い `@capacitor/app`(バックボタン制御)を追加。HTTP は `CapacitorHttp.request` を明示利用(`fetch` パッチに依存しない)。
- **ビルド**: `npm run mobile:apk` は Windows/Unix 共通にするため `mobile/scripts/apk.mjs` が `gradlew(.bat) assembleDebug` を呼ぶ。この PC は JDK/Android SDK が無く APK は未ビルド(`cap add android` / `cap sync` までは成功)。
