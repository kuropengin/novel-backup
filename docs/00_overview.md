# 00. 概要

ハーメルン / 小説家になろう / カクヨムを **Android アプリ(`mobile/`)で元サイトのまま直接閲覧** し、気に入った作品を **自前サーバーに「お気に入り」として保存** する個人用システム。

```
Android アプリ (Capacitor + Vue)            サーバー (Express + SQLite)
  ├ 設定 / 初期設定 / ログイン               ├ /api/auth      Bearer トークン発行・パスワード変更
  ├ ホーム: 3 サイトをネイティブ WebView(SiteView)で表示   ├ /api/bookmarks お気に入り(ユーザー毎)
  │   └ ★ ボタンで保存                       └ /api/users     ユーザー管理(admin のみ)
  └ ユーザー管理 (admin のみ)                  DB: data/novel-backup.db
```

## 方針

- サイトの表示は端末の WebView が行う。
- 認証は **Bearer トークンのみ**(Cookie セッション・CSRF 対策なし)。個人利用・LAN 運用が前提。
- ロールは `admin`(ユーザー管理可)と `viewer`。お気に入りはユーザー毎。


## ドキュメント

- [01_server_api.md](01_server_api.md): サーバー API・認証・設定
- [02_data_model.md](02_data_model.md): DB スキーマとマイグレーション
- [03_mobile_app.md](03_mobile_app.md): アプリの画面・保存の流れ・本文表示設定・ビルド
