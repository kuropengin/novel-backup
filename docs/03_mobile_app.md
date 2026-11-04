# 03. Android アプリ(`mobile/`)

Capacitor 7 + Vue 3 + TypeScript + Vite。`appId: local.novelbackup.app`、`appName: 小説ビューア`。Android のみ。

## 構成

| 項目 | 内容 |
|---|---|
| サイト表示 | 自作 Capacitor プラグイン `SiteView`(`android/.../SiteViewPlugin.java`、TS は `src/native/siteView.ts`)。アプリ WebView の上にネイティブ WebView を矩形(上下インセット)で重ねる。仕様は [04_mobile_redesign.md](04_mobile_redesign.md)。3 サイト外のホスト/スキームへは**遷移せず**、確認ダイアログ(「外部サイトへのリンクです。ブラウザで開きますか?」+URL)で OK のときだけ既定ブラウザで開く(下記「外部リンク」) |
| 通信 | `CapacitorHttp.request`(ネイティブ HTTP。CORS 回避)。認証は `Authorization: Bearer` |
| 保存 | `@capacitor/preferences`(サーバー URL・トークン・ユーザー名・ロール・本文表示設定。端末ローカル) |
| 平文 HTTP | LAN サーバーに接続するため `android:usesCleartextTraffic="true"` |
| プラグイン | `@capacitor/app` `dialog` `network` `preferences` `status-bar` |
| 戻るボタン | 上記「シェル」参照 |

## 画面

デザインは [04_mobile_redesign.md](04_mobile_redesign.md)(X のダークテーマ風。既定ダーク、ライトは上バーのボタンで切替、アプリ UI のみ)。CSS 変数は `src/styles.css`、アイコンはインライン SVG(`components/Icon.vue`)。

### ログイン前(`views/AuthView.vue`)
サーバー URL を入力して「接続して確認」→ `GET /api/auth/status`。`setupRequired` なら **初期設定**(最初の admin 作成 → そのままログイン)、それ以外は **ログイン**。成功するとメインのシェルが表示される。

### シェル(`Shell.vue`)
- **上バー**: 左=アバター(ユーザー名の頭文字)→ 左から出るサイドメニュー(ユーザー名・ロール、設定、ユーザー管理(admin のみ)、ログアウト)/ 中央=アプリアイコン / 右=「Aa」(本文表示シート: フォント 明朝/ゴシック・文字サイズ 5 段階・行間)とテーマ切替。
- **下バー**: ホーム / お気に入り / **★(大きい円形)** / 閲覧履歴 / お知らせ(未読バッジ)。★ は SiteView が作品/話ページを表示中のみ有効、登録済みなら塗りつぶし。登録済みで押すと確認ダイアログ(`@capacitor/dialog`)→ 解除。
- **バー自動非表示**: 下スクロール(しきい値 8px)で上下バーをスライドアウトし、上スクロール/先頭到達/ページ遷移で戻す。リスト画面は window のスクロール、SiteView はネイティブの `scroll` イベントで判定(`logic/scrollHide.ts`)。SiteView 表示中はバーの状態に合わせて `setInsets({top, bottom, animate:true})`(表示: 上下バーの高さ、非表示: 0)。インセット変更後 250ms はスクロールイベントを無視してフィードバックを防ぐ。
- **戻るボタン**: サイドメニュー/シート → サブ画面(設定・ユーザー管理) → SiteView 内で戻る → SiteView を閉じる → ホーム以外ならホームへ → 終了。ホームの再タップで SiteView を閉じる。
- ネイティブビューは HTML より前面に描くため、サイドメニュー・Aa シート表示中、ホーム以外のタブ、サブ画面では `setVisible(false)`(状態は保持)。

### 各画面
1. **ホーム**(`screens/HomeScreen.vue`): サイトカード 3 つ(なろう/カクヨム/ハーメルン。サイト色のアクセント)→ SiteView で開く。**閲覧作品**は `GET /api/history?view=novel` を新しい順に表示(作品名 / 最後に読んだ話 / 相対時刻)、タップで最後に読んだ話の URL を開く。
2. **お気に入り**(`BookmarksScreen.vue`): 検索(タイトル・作者・サイト)、並べ替えシート(追加日 / 更新日(**未対応**、追加日で代用)/ タイトル / サイト × 昇順・降順。`logic/lists.ts`)。行=サイトバッジ・タイトル・作者・追加日と、**バックアップ**・**オフライン保存**の状態アイコン(今回は常にグレー=なし)。タップで SiteView、長押し/左スワイプで確認付き削除。**オフライン時**(`@capacitor/network`)はオフライン保存済みのみ表示=今回は空状態メッセージ。
3. **閲覧履歴**(`HistoryScreen.vue`): 検索(サーバー側 `q`)、セグメント エピソード毎/作品毎、タップで SiteView、長押しで削除(エピソード=1 行、作品毎=作品単位)。
4. **お知らせ**(`NotificationsScreen.vue`): 端末内の通知ストア(`stores/notifications.ts`、`notify({kind, title, body})`)。既読管理・すべて既読・全削除。発生源は未実装のため通常は空状態。
5. **設定**(サイドメニューから。`views/SettingsView.vue`): アカウント、サーバー URL(変更はログアウトして接続し直す)、パスワード変更(`POST /api/auth/password`)。
6. **ユーザー管理**(admin。`views/UsersView.vue`): 一覧、追加、ロール変更、パスワード再設定、削除(確認はネイティブダイアログ)。サーバーのエラー(最後の管理者・自分は削除不可 等)は画面に表示。

起動時にトークンの有効性とロールを `GET /api/auth/status` で再確認する(失効していればログイン画面へ)。401 を受けるとトークンを破棄してログイン画面へ戻る。

### 閲覧履歴の記録
SiteView の `pageFinished`(カクヨムの SPA 遷移は合成イベント)毎に、作品/話ページ(`logic/sites.ts` の `classifyUrl`)なら `evaluate` でタイトルを読み取り `POST /api/history`(1 ページ読み込みにつき 1 回)。オフライン/通信失敗時は `@capacitor/preferences`(`historyQueue`、最大 200 件・URL 重複は最新のみ)に溜め、起動時とオンライン復帰時に古い順で送信(`logic/historyQueue.ts`)。

## お気に入り保存の流れ

1. 下バーの ★ を押すと、`SiteView.evaluate` で注入スクリプト(`src/inject.ts` の `pageInfoCode()`)を実行し、表示中ページの DOM から `{url, novelTitle, episodeTitle, author}` を読み取る。**自動取得は行わない。**
2. アプリが `POST /api/bookmarks { url, title, author? }` を呼ぶ。サーバーは `resolveUrl` で作品に解決する(話ページでも可。作品/話ページでなければ `not_a_novel_page`)。
3. 結果を下バー上のトーストで表示(保存しました / 登録済みです / 作品ページではありません / サーバーに接続できません)。

★ とトーストはサイトの色に依存しない固定スタイル(★: 黄色の丸+白枠+影、トースト: 緑/赤背景+白文字+白枠+影)で、どのサイトでも読める。サイト全体への配色変更や広告非表示は行わない。

### タイトル取得(注入スクリプト内、サイト別)

| サイト | 作品ページ | 話ページ |
|---|---|---|
| なろう | `.p-novel__title`、作者 `.p-novel__author a` | `.p-novel__title` は話タイトルのため、パンくずの `a[href="/<ncode>/"]`、無ければ `document.title` から除去 |
| カクヨム | `h1` 内 `a` | `#contentMain-header-workTitle`。作者は `document.title` の `（作者）` |
| ハーメルン | `span[itemprop="name"]` 等(**実 DOM 未検証**) | `a[href="/novel/<id>/"]` のテキスト等(未検証)、最後は `document.title` を整形 |

取得できなくても `document.title` 等で必ず title を作って送る(サーバーは title 必須)。誤ったタイトルは `PATCH /api/bookmarks/:id` で直せる(アプリには編集 UI なし)。

## 本文の表示設定

上バーの「Aa」シートで **文字サイズ(5 段階: 15/17/19/22/26px、既定 19)**・**行間(1.5/1.7/1.9/2.2、既定 1.9)**・**フォント(明朝/ゴシック、既定 明朝)** を変更でき、プレビュー付き。`@capacitor/preferences` の `display` キーに JSON 保存。

`pageFinished` ごとに `SiteView.insertCss` で、各サイトの **話ページ本文コンテナだけ** に適用する(配色・背景・ヘッダー・広告・画像には触れない)。ルビ(`rt`)は 0.5em。

| サイト(ホスト) | 本文セレクタ |
|---|---|
| なろう(`*.syosetu.com`) | `.p-novel__text`, `#novel_honbun`, `#novel_p`, `#novel_a` |
| カクヨム(`kakuyomu.jp`) | `.widget-episodeBody` |
| ハーメルン(`syosetu.org`) | `#honbun`, `#maegaki`, `#atogaki`(実 DOM 未検証) |

3 サイト以外のホストでは何も注入しない。変更は次のページ読み込みから反映(ブラウザが開いている場合は再注入を試みる)。ロジックは `src/display/index.ts`(純粋関数、`test/display.test.ts` で検証)。

## 広告ブロック

サイトビューア(SiteView)内だけで、DNS 形式ブロックリストのドメインへの通信を遮断する。**端末の DNS は変更しない**(WebView にリゾルバ差し替えは無く、VpnService も使わない)。

- リスト設定はユーザー別にサーバー(`/api/blocklists`)が保持。端末が有効な URL をダウンロードして解析する(サーバーは URL を取得しない)。`stores/adblock.ts` が起動時・ログイン後に取得し、有効 URL を Preferences にキャッシュ(ユーザー名付き。ネットワーク不達時はこれを使う)して `SiteView.setBlocklists({urls})` を呼ぶ。ログアウト/ユーザー切替(`App.vue` の watch)で `setBlocklists({urls: []})` とキャッシュ削除。
- ネイティブ: `BlocklistManager`(ダウンロード/キャッシュ/世代管理/差し替え)、`BlocklistParser`(hosts・ドメイン行・`*.domain`・`||domain^`・`@@||domain^` 例外。修飾子/パス/正規表現/内部ワイルドカードは読み飛ばし)、`DomainMatcher`(完全一致+親ドメイン、例外優先)。いずれも Android 非依存で `app/src/test` の JUnit でテスト。キャッシュは `filesDir/blocklists/<sha256(url)>.txt`、24 時間で再取得、失敗時はキャッシュへフォールバック(fail-open)、1 リスト 30MB・合計 50 万ドメインまで。
- `SiteClient.shouldInterceptRequest`: メインフレーム以外の http(s) でホストが一致したら、空の `text/plain` 200 を返す。`ALLOWED_HOST_SUFFIXES`(3 サイト)とそのサブドメインは常に対象外、例外時は通常読み込み。アプリ UI の WebView には適用しない。
- 設定画面の「広告ブロック」でリスト別のオン/オフ・件数・最終更新・失敗表示、独自リストの追加/削除(`getBlocklistStatus`)。

## ビルド

```bash
npm run mobile:sync   # mobile をビルドして cap sync android
npm run mobile:apk    # gradlew assembleDebug → mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

`mobile/scripts/apk.ts` は JAVA_HOME が未設定または JDK 22 以上のとき `%USERPROFILE%\.jdks` から JDK 21 を自動検出し、ANDROID_HOME が未設定なら `%LOCALAPPDATA%\Android\Sdk` を使う。詳細は [mobile/README.md](../mobile/README.md)。

## 外部リンク

アプリは `narou` / `kakuyomu` / `hameln`(`syosetu.org`、`*.syosetu.com`、`kakuyomu.jp` とサブドメイン)以外へは遷移しない。許可外のリンク(リダイレクト、`window.open`、`target=_blank`、`mailto:`・`tel:`・`intent:` 等)をタップすると、SiteView は遷移を止めて `externalLink` イベントを送り、アプリがネイティブ確認「外部サイトへのリンクです。ブラウザで開きますか?」(URL 付き、長い場合は切り詰め)を表示する。OK のときだけ `openExternal` で既定ブラウザ等を起動(http/https/mailto/tel のみ。`intent:` は `browser_fallback_url` があればそれ、無ければ開けない旨を表示)。キャンセルなら何もしない。許可リストは `SiteViewPlugin.java` と `src/logic/sites.ts` で一致させる(`test/logic.test.ts` で TS 側を検証)。
