# 小説ビューア(novel-backup)

ハーメルン / 小説家になろう / カクヨムを **Android アプリで元サイトのまま直接閲覧** し、気に入った作品を自分のサーバーに「お気に入り」として保存する個人用システムです。

- **mobile/**: Android アプリ(Capacitor + Vue)。3 サイトを WebView で表示し、★ ボタンで保存。本文の文字サイズ・行間・フォント設定、初期設定、ユーザー管理(管理者)を備えます。
- **server/**: お気に入りとユーザーを保存する API サーバー(Express + SQLite、Bearer トークン認証)。サイトへは一切アクセスしません。

自動取得・チャレンジ突破・UA/指紋偽装は行いません。Web クライアント・Proxy・バックアップ機能は削除しました(完全版はコミット `2892245`)。

設計は [docs/](docs/) を参照してください([概要](docs/00_overview.md) / [サーバー API](docs/01_server_api.md) / [データモデル](docs/02_data_model.md) / [アプリ](docs/03_mobile_app.md))。

## 動作環境

- Node.js **22.13 以上**(組み込みの `node:sqlite` を使用)
- APK のビルド: JDK 21 と Android SDK(Android Studio に同梱)

## セットアップとサーバー起動

```bash
npm install
npm run build   # server(tsc)と mobile(vue-tsc + vite)をビルド
npm start       # http://localhost:3000(PORT で変更)。全インターフェースで待ち受け
```

開発時は `npm run dev`(`tsx watch`)。DB は `data/novel-backup.db`(`DATA_DIR` で場所を変更可)。環境変数は `PORT` と `DATA_DIR` のみです。

最初のユーザーはアプリの設定画面の **初期設定** で作成します(管理者)。以降は管理者がアプリの「ユーザー管理」から追加します。

実機から接続するには、PC のファイアウォールで TCP 3000 の受信を LAN から許可してください。外部に公開する場合は HTTPS のリバースプロキシを置いてください(アプリは `usesCleartextTraffic` を有効にしています)。

## アプリのビルドとインストール

```bash
npm run mobile:sync   # mobile をビルドして android/ へ同期
npm run mobile:apk    # debug APK をビルド(JDK 21 / Android SDK を自動検出)
```

APK: `mobile/android/app/build/outputs/apk/debug/app-debug.apk`。詳細は [mobile/README.md](mobile/README.md)。

サーバー URL: エミュレータは `http://10.0.2.2:3000`、実機は PC の LAN アドレス(例 `http://192.168.1.10:3000`)。

## スクリプト

| コマンド | 内容 |
|---|---|
| `npm run dev` | サーバーを watch 起動 |
| `npm run build` | server + mobile(Web)をビルド |
| `npm start` | ビルド済みサーバーを起動 |
| `npm run typecheck` | server / mobile の型検査 |
| `npm test` | server(vitest + supertest)/ mobile(vitest) |
| `npm run mobile:sync` | mobile ビルド + `cap sync android` |
| `npm run mobile:apk` | debug APK をビルド |
