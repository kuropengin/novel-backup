# mobile — 小説ビューア(Android アプリ)

ハーメルン / なろう / カクヨムを **Proxy を通さず元サイトで直接表示** し、気に入った作品を既存サーバー(Web 版と同じ DB)に「お気に入り」として保存する Android アプリです。
Capacitor 7 + Vue 3 + TypeScript + Vite。仕様は [docs/08_mobile_app.md](../docs/08_mobile_app.md)。

アプリは利用者が操作する通常のブラウザ(WebView)として動作します。自動取得・チャレンジ突破・指紋/UA 偽装などは行いません。

## 前提

- サーバー(`npm start`)が起動していること。ユーザー(管理者または閲覧者)が作成済みであること。
- ビルド環境: **Android Studio**(JDK 21 と Android SDK が同梱)。コマンドラインでビルドする場合は JDK 21 と Android SDK(`ANDROID_HOME`)が必要です。
- Node.js 22.13 以上(リポジトリ共通)。

## ビルドと端末へのインストール

リポジトリのルートで実行します。

```bash
npm install
npm run mobile:sync     # mobile をビルドし、npx cap sync android で android/ へ反映
npm run mobile:apk      # mobile/android で gradlew assembleDebug(JDK/SDK が必要)
```

debug APK は `mobile/android/app/build/outputs/apk/debug/app-debug.apk` に出力されます。

- adb で入れる場合: `adb install -r mobile/android/app/build/outputs/apk/debug/app-debug.apk`
- Android Studio で入れる場合: `npx cap open android`(または `mobile/android` を開く)→ 端末/エミュレータを選んで Run。
- APK ファイルを端末へ転送して「提供元不明のアプリ」を許可してインストールしても構いません。

Web 側(`mobile/src`)を変更したら、再度 `npm run mobile:sync` してからビルドしてください。`mobile/android/` 内の Web アセットや `capacitor.config.json` は同期で生成されるため Git 管理外です。

## 初回起動

1. 設定画面で **サーバー URL** を入力します。例: `http://192.168.1.10:3000`(サーバー PC の LAN アドレス)。
2. ユーザー名・パスワードでログインすると Bearer トークン(有効 90 日)が端末に保存されます。
3. ホームのサイトボタンから各サイトを開き、作品ページ/話ページで右下の ★ を押すと保存されます。保存した作品はホームの一覧からも開けます。

サーバー側の準備:

- サーバーは全インターフェースで待ち受けます(`app.listen(PORT)`)。Windows のファイアウォールで **TCP 3000(`PORT`)の受信を LAN から許可** してください。
- 端末とサーバー PC が同じネットワークにあること(VPN/ゲストネットワークの分離に注意)。
- LAN 内の HTTP に接続するため、アプリは `android:usesCleartextTraffic="true"` です。外部に出す場合は HTTPS のリバースプロキシを使ってください(その場合は `COOKIE_SECURE=true` 等、ルート README 参照)。

## 表示テーマ・広告非表示

設定画面の「表示」で、3 サイト(なろう/カクヨム/ハーメルン)に注入する配色(ライト/セピア/ダーク)・文字サイズ・行間・明朝/ゴシック・広告非表示(既定 ON)を変更できます(端末に保存)。変更は次にページを開いたときから反映されます。仕様と広告セレクタの調査結果は [docs/09_mobile_theming.md](../docs/09_mobile_theming.md)。テストは `npm test -w mobile`。

## 操作

- ブラウザ画面の Android 戻るボタン: ページ内で1つ戻り、履歴がなければ閉じます。
- ★ 押下後のトースト: 「保存しました」「登録済みです」「作品ページではありません」「サーバーに接続できません」。ログイン期限切れ(401)のときは再ログインを促し設定画面へ戻ります。

## 制限・注意

- **ハーメルンの作品タイトル取得は未検証** です(DOM を確認できていないため推測のセレクタ + `document.title` の整形)。誤ったタイトルで保存された場合は Web 版のブックマーク画面の「タイトル編集」で直せます。
- ハーメルン等で **Cloudflare のチャレンジ** が表示されることがあります。アプリは何も回避しないため、表示された場合は利用者自身がブラウザ画面上で通過してください。
- バックアップ機能は本アプリでは使いません。`title` 付きで保存したブックマークは即時バックアップされません(定期バックアップは管理設定の間隔に従います。止めたい場合は間隔 0)。
- Android のみ対応です(iOS は対象外)。
- APK のビルドには JDK 21 と Android SDK が必要です。`npm run mobile:apk` は JAVA_HOME が未設定/JDK 22 以上なら `%USERPROFILE%.jdks` の JDK 21 を、ANDROID_HOME 未設定なら `%LOCALAPPDATA%AndroidSdk` を自動で使います(無い環境では `npm run mobile:sync` までは可能)。
