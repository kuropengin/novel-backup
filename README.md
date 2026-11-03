# 小説ビューア(novel-backup)

ハーメルン / 小説家になろう / カクヨムを **Android アプリで元サイトのまま直接閲覧** し、気に入った作品を自分のサーバーに「お気に入り」として保存する個人用システムです。

- **mobile/**: Android アプリ(Capacitor + Vue)。3 サイトを WebView で表示し、★ ボタンで保存。本文の文字サイズ・行間・フォント設定、初期設定、ユーザー管理(管理者)を備えます。
- **server/**: お気に入りとユーザーを保存する API サーバー(Express + SQLite、Bearer トークン認証)。サイトへは一切アクセスしません。


設計は [docs/](docs/) を参照してください([概要](docs/00_overview.md) / [サーバー API](docs/01_server_api.md) / [データモデル](docs/02_data_model.md) / [アプリ](docs/03_mobile_app.md))。

## 現在の機能

- お気に入り一覧から作品ごとの **即時バックアップ**
- バックアップ済み本文の **アプリ内リーダー表示**
- バックアップ本文の **端末オフライン保存/更新**
- バックアップ完了通知の **お知らせ一覧同期**
- 管理者向け **バックアップ定期設定**(実行間隔/時刻/並列数)

## 動作環境

- Node.js **26 以上(LTS。`.nvmrc` 参照)**(組み込みの `node:sqlite` を使用)
- Python **3.11 以上**(Scrapling バックアップタスク用)
- APK のビルド: JDK 21 と Android SDK(Android Studio に同梱)

## セットアップとサーバー起動

```bash
npm install
pip install -r server/python/requirements.txt
npm run build   # server(tsc)と mobile(vue-tsc + vite)をビルド
SETUP_TOKEN=<ランダムな文字列> npm start   # http://127.0.0.1:3000(HOST / PORT で変更)。既定はループバックのみ
```

開発時は `npm run dev`(`tsx watch`)。DB は `data/novel-backup.db`(`DATA_DIR` で場所を変更可)。

バックアップ関連の環境変数:

- `BACKUP_FREQUENCY`: `hourly` / `daily` / `weekly` (既定: `hourly`)
- `BACKUP_MAX_PARALLEL`: 最大並列数 (既定: `5`)
- `BACKUP_TIME`: `daily`/`weekly` 時の実行時刻 `HH:mm` (既定: `03:00`)
- `BACKUP_PYTHON_BIN`: Python 実行ファイル (既定: `python`)

最初のユーザーはアプリの設定画面の **初期設定** で作成します(管理者)。サーバー起動時に環境変数 `SETUP_TOKEN` を設定し、初期設定画面で同じ値(セットアップトークン)を入力します。未設定だと初期設定はできません。以降は管理者がアプリの「ユーザー管理」から追加します。

実機から接続するには、同一マシンの nginx / Caddy で HTTPS を終端して `127.0.0.1:3000` へ転送してください(設定例・環境変数一覧・レート制限は [docs/05_deployment.md](docs/05_deployment.md))。開発時に LAN から直接つなぐ場合のみ `HOST=0.0.0.0` を指定し、TCP 3000 の受信を LAN から許可します。

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
