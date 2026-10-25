# 小説バックアップ(novel-backup)

ハーメルン・「小説家になろう」・カクヨムのブックマーク作品を個人的にバックアップするツール。サーバー(Node.js)+クライアント(Vue3 / PWA)のモノレポひな型。

## 構成

- `server/` … Express。REST API、ビルド済みクライアントの同一origin配信(PWAとしてインストール可能)。
- `client/` … Vue3 + Vite + vue-router + vite-plugin-pwa(manifest/service worker)。devサーバーは `/api`・`/proxy` を3000へ中継。

## 動作要件

- Node.js **22.5+**(`node -v` で確認)

## セットアップ

```bash
npm install          # ルートで workspace 一括インストール
```

### 開発モード

```bash
npm run dev          # server(3000) + client(5173)
# http://localhost:5173
```

### 本番(単一サーバー / PWA)

```bash
npm run build        # client/dist を生成
npm start            # server が 3000 で API + dist を同一origin配信
# http://localhost:3000 → ブラウザで「アプリとしてインストール」できる
```

## 環境変数(server)

| 変数 | 既定値 | 意味 |
|---|---|---|
| `PORT` | 3000 | サーバーポート |

## 注意事項

- 取得する小説本文は著作権で保護される。自分がブックマークしている作品を自分のサーバーに保全する**私的使用**のみ。公開・再配布・複数ユーザー間の共有は行わない。
- スクレイピングは節度(間隔を空ける)、利用規約・robots.txt を尊重する。
