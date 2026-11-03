# 05. デプロイ(同一マシンのリバースプロキシ構成)

サーバーは `127.0.0.1` だけで待ち受け、同じマシン上の nginx または Caddy が HTTPS を終端して転送する。

```
スマホ/ブラウザ --HTTPS--> nginx / Caddy (443) --HTTP--> 127.0.0.1:3000 (novel-backup)
```

## 環境変数

| 変数 | 既定 | 内容 |
|---|---|---|
| `HOST` | `127.0.0.1` | 待ち受けアドレス。リバースプロキシ前提のため既定はループバックのみ。LAN から直接つなぐ開発時だけ `0.0.0.0` にする |
| `PORT` | `3000` | 待ち受けポート |
| `DATA_DIR` | `<repo>/data` | DB(`novel-backup.db`)と `apk/` の置き場 |
| `SETUP_TOKEN` | なし | 初回管理者作成(`POST /api/auth/setup`)に必要なトークン。**未設定だと初期設定は無効**(`403 setup_disabled`)。十分長いランダム文字列にする(例: `openssl rand -base64 24`) |
| `BACKUP_FREQUENCY` | `hourly` | `hourly` / `daily` / `weekly` |
| `BACKUP_TIME` | `03:00` | `daily`/`weekly` の実行時刻 `HH:mm`(00:00〜23:59) |
| `BACKUP_MAX_PARALLEL` | `5` | 最大並列数 |
| `BACKUP_PYTHON_BIN` | `python` | Python 実行ファイル |

`SETUP_TOKEN` はユーザーが 1 人でも作成されたあとは使われない(`409 already_setup`)。初期設定の完了後は環境変数から外してよい。

## 信頼するプロキシ

アプリは `trust proxy = loopback` で動く。つまり **接続元がループバック(= 同一マシンのプロキシ)のときだけ** `X-Forwarded-For` / `X-Forwarded-Proto` を信用し、`req.ip`(レート制限のキー)と HTTPS 判定(HSTS)に使う。

- プロキシ側は `X-Forwarded-For` を**追記ではなく上書き**する(`$remote_addr` のみを入れる)。クライアントが偽装した値を持ち込ませないため。
- `HOST` を `0.0.0.0` にして外部から直接つなげる構成にしてはいけない(ループバック以外からは転送ヘッダが無視されるだけで害は小さいが、HTTPS が使われない)。

## nginx

```nginx
server {
    listen 443 ssl http2;
    server_name novel.example.com;

    ssl_certificate     /etc/letsencrypt/live/novel.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/novel.example.com/privkey.pem;

    # API の本文は小さい(サーバー側でも認証系 16kb / その他 256kb に制限)
    client_max_body_size 512k;

    # 進捗 SSE。バッファリングを切り、長時間接続を許す
    location /api/backup/progress {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;      # 上書き($proxy_add_x_forwarded_for は使わない)
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 1h;
    }

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }
}

server {
    listen 80;
    server_name novel.example.com;
    return 301 https://$host$request_uri;
}
```

APK(`/download/novel-backup.apk`)は数十 MB になりうるが、これはダウンロード(レスポンス)なので `client_max_body_size` には影響しない。

## Caddy

Caddy は HTTPS 証明書の取得・更新を自動で行う。`X-Forwarded-For` は Caddy が既定でクライアントのアドレスに上書きし、`X-Forwarded-Proto` も付ける(`trusted_proxies` を設定しない限り、受信した値は破棄される)。

```caddyfile
novel.example.com {
    request_body {
        max_size 512KB
    }

    # SSE は flush_interval -1 で即時転送(バッファリングなし)
    @sse path /api/backup/progress
    reverse_proxy @sse 127.0.0.1:3000 {
        flush_interval -1
        transport http {
            read_timeout 1h
        }
    }

    reverse_proxy 127.0.0.1:3000
}
```

## セキュリティ上の挙動(サーバー側)

- 全レスポンスに `X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`X-Frame-Options: DENY`。HTTPS(`X-Forwarded-Proto: https`)のときは `Strict-Transport-Security`。`/api/*` は `Cache-Control: no-store`。`/download` の HTML ページには厳格な CSP(インラインスタイルのみ許可)。
- `/download` はビルド済み APK の SHA-256 を表示する(mtime+サイズでキャッシュ)。ユーザーは配布元のハッシュと照合できる。
- レート制限(メモリ上・再起動で消える・期限切れは定期的に掃除):

| 対象 | 制限 |
|---|---|
| `POST /api/auth/token` | IP(IPv6 は /64)10 回/分 + ユーザー名(小文字)ごとに失敗 5 回で 1 分ロック、以降失敗ごとに倍(上限 15 分)。成功で解除。ロック中は `429 { error: "too_many_requests", retryAfter }` + `Retry-After` |
| `POST /api/auth/setup` | IP 5 回/分 |
| `POST /api/auth/password` | ユーザーごと 10 回/15 分 |
| `POST /api/backup/novels/:site/:novelKey/trigger` | 一般ユーザー 5 回/10 分、管理者 30 回/10 分、全体 30 回/10 分。超過は `429 { error: "rate_limited", retryAfter }` + `Retry-After` |
| `GET /api/backup/progress`(SSE) | ユーザーごと 3 接続、全体 50 接続(超過は 429)。60 秒ごとにトークンを再検証し、失効していれば切断。最大 30 分で切断(クライアントは再接続する) |

- パスワードは bcrypt コスト 12。コストが低い古いハッシュは、ログイン成功時に自動で再ハッシュする。
- 500 エラーはサーバーログにのみ詳細を出し、クライアントには `{ "error": "internal_error" }` だけを返す。
- Python スクレイパー呼び出しは 120 秒でタイムアウトし、子プロセスを強制終了する。

## 既知の未対応

- 作品タイトルの共有編集(ブックマーク `PATCH` の `title` は共有の作品タイトルを更新する)は、現状どおり全ユーザーに許可している。
