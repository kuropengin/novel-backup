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

- サイトの表示は端末の WebView が行う。**サーバーはサイトへ一切アクセスしない**(取得・解析・Proxy・バックアップなし)。
- 自動取得・Cloudflare 等のチャレンジ突破・UA/指紋偽装は行わない。アプリは利用者が操作する通常のブラウザとして動く。
- 認証は **Bearer トークンのみ**(Cookie セッション・CSRF 対策なし)。個人利用・LAN 運用が前提。
- ロールは `admin`(ユーザー管理可)と `viewer`。お気に入りはユーザー毎。

## 削除済みの機能

Web クライアント(Vue/PWA)、内部 Proxy、ライブ閲覧(リーダーモード)、定期バックアップと版管理・差分表示、サイトアダプタ(取得/解析)、管理設定 API、アプリの配色テーマ・広告非表示は削除した。
復元・参照が必要な場合は、削除前の完全版であるコミット `2892245`(`git show 2892245:docs/...` / `git checkout 2892245`)を参照する。

## ドキュメント

- [01_server_api.md](01_server_api.md): サーバー API・認証・設定
- [02_data_model.md](02_data_model.md): DB スキーマとマイグレーション
- [03_mobile_app.md](03_mobile_app.md): アプリの画面・保存の流れ・本文表示設定・ビルド
