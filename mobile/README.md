# mobile — 小説ビューア(Android アプリ)

ハーメルン / なろう / カクヨムを元サイトで直接表示し、気に入った作品をサーバーに「お気に入り」として保存する Android アプリです。Capacitor 7 + Vue 3 + TypeScript + Vite。仕様は [docs/03_mobile_app.md](../docs/03_mobile_app.md)。

アプリは利用者が操作する通常のブラウザ(WebView)として動作します。自動取得・チャレンジ突破・指紋/UA 偽装などは行いません。

## 前提

- Node.js 26 以上、JDK 21、Android SDK(Android Studio に同梱)。
- サーバー(ルートの `npm start`)が起動していること。

## ビルドとインストール

リポジトリのルートで実行します。

```bash
npm install
npm run mobile:sync   # mobile をビルドし cap sync android で android/ へ反映
npm run mobile:apk    # gradlew assembleDebug
```

`npm run mobile:apk` は JAVA_HOME が未設定または JDK 22 以上の場合 `%USERPROFILE%\.jdks` の JDK 21 を、ANDROID_HOME が未設定なら `%LOCALAPPDATA%\Android\Sdk` を自動で使います(使用 JDK を表示)。

APK は `mobile/android/app/build/outputs/apk/debug/app-debug.apk` に出力され、配布用に `data/apk/novel-backup.apk`(`DATA_DIR` 指定時は `<DATA_DIR>/apk/`)へもコピーされます。

- サーバー経由: 端末のブラウザで `<サーバーURL>/download` を開いてダウンロード(認証不要。サーバー再起動は不要)。
- adb: `adb install -r mobile/android/app/build/outputs/apk/debug/app-debug.apk`
- Android Studio: `npx cap open android` → 端末/エミュレータを選んで Run。
- APK を端末へ転送して手動インストールしても構いません。

`mobile/src` を変更したら再度 `npm run mobile:sync` してからビルドしてください。`mobile/android/` 内の Web アセット等は同期で生成されるため Git 管理外です。

## 初回起動

1. 起動直後のログイン画面でサーバー URL を入力し「接続して確認」。
   - エミュレータ: `http://10.0.2.2:3000`
   - 実機: サーバー PC の LAN アドレス(例 `http://192.168.1.10:3000`)。PC のファイアウォールで TCP 3000 の受信を許可し、同じネットワークに接続してください。
2. サーバーにユーザーがいなければ **初期設定** フォームが出ます。ユーザー名・パスワード(8 文字以上)・確認を入力すると管理者が作成され、そのままログインします。ユーザーがいる場合はログインフォームが出ます。
3. ホームのサイトカードから各サイトを開き、作品ページ/話ページで下バー中央の ★ を押すと保存されます(登録済みで押すと解除の確認)。お気に入り・閲覧履歴・お知らせは下バーのタブから。

左上のアバターからサイドメニューを開くと、設定(パスワード変更)・ユーザー管理(管理者のみ)・ログアウトがあります。上バーの「Aa」で本文の表示、隣のボタンでダーク/ライトを切り替えます。スクロールすると上下バーが自動で隠れます。

## 本文の表示設定

上バーの「Aa」で文字サイズ・行間・明朝/ゴシックを変更できます(プレビューあり、端末に保存)。各サイトの話ページの本文コンテナにだけ適用され、配色や広告には触れません。変更は開いているページにも即時反映されます。テストは `npm test -w mobile`。

## 注意

- ハーメルンの作品タイトル取得と本文セレクタは実ページで未検証です(推測のセレクタ + `document.title` の整形)。
- ログイン期限(90 日)が切れる、またはパスワードが変更されると再ログインが必要です。
- Android のみ対応です。
