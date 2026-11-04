# 06. Docker での構築

`docker compose` でアプリ(API + 定期バックアップ)を動かす。HTTPS は既存の nginx コンテナ(`~/docker/proxy`、ネットワーク `proxy_web`)で終端し、アプリのポートはホストに公開しない。

```
スマホ --HTTPS--> nginx コンテナ (443) --proxy_web--> novel-backup:3000
```

## 構成ファイル

| ファイル | 内容 |
|---|---|
| `Dockerfile` | サーバーイメージ。Node 26 + Python 3.12(スクレイパー)。UID 1000 の非 root ユーザーで動く |
| `docker-compose.yaml` | `app`(コンテナ名 `novel-backup`)。外部ネットワーク `proxy_web` に参加 |
| `.env.example` | 環境変数のひな形(`.env` にコピーして使う。`.env` は git 管理外) |

## 手順

```bash
git clone https://github.com/kuropengin/novel-backup.git
cd novel-backup

cp .env.example .env
#   SETUP_TOKEN=$(openssl rand -base64 24) の値

mkdir -p data && sudo chown 1000:1000 data   # コンテナ(UID 1000)が DB を書き込めるようにする

docker compose up -d --build
docker compose logs -f app
docker exec novel-backup node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>r.text()).then(console.log)"
```

nginx の conf を追加して `docker compose -f ~/docker/proxy/docker-compose.yml exec proxy nginx -s reload`。

アプリでサーバー URL に `https://<ドメイン>` を入力し、初期設定画面で `SETUP_TOKEN` の値を入れて管理者を作る。作成後は `.env` の `SETUP_TOKEN` を空にして `docker compose up -d` してよい。

## nginx(`~/docker/proxy/config/conf.d/novel.conf`)

```nginx
server {
    server_name novel.kuropengin.com;

    # Docker 内蔵 DNS で都度解決する(novel-backup が停止していても nginx が起動できるように)
    resolver 127.0.0.11 valid=30s;
    set $novel_backup http://novel-backup:3000;

    # API の本文は小さい(アプリ側でも認証系 16kb / その他 256kb に制限)
    client_max_body_size 512k;

    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host $host;
    # 接続元 IP はログイン回数制限に使う。追記($proxy_add_x_forwarded_for)ではなく上書きする
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;

    # 進捗 SSE。バッファリングを切り、長時間接続を許す
    location /api/backup/progress {
        proxy_pass $novel_backup;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 1h;
    }

    location / {
        proxy_pass $novel_backup;
        proxy_read_timeout 60s;
    }

    listen 443 ssl;
    include conf.d/common/ssl-key.conf;
}

server {
    if ($host = novel.kuropengin.com) {
        return 301 https://$host$request_uri;
    }
    server_name novel.kuropengin.com;
    listen 80;
    return 404;
}
```

- `X-Forwarded-For $remote_addr` は必須。無いと全員の接続元が nginx 1 つに見え、1 人のログイン失敗で全員が制限される。
- CORS ヘッダ(`Access-Control-Allow-*`)は付けない。アプリはネイティブ HTTP で通信するので不要で、付けると他サイトのページから API を呼べるようになる。
- `Upgrade` / `Connection: upgrade` は不要(WebSocket は使わない)。
- 証明書(certbot)は既存サイトと同じ手順で `novel.kuropengin.com` を追加する。

## 信頼するプロキシ(TRUST_PROXY)

アプリのポートはホストに公開しないため、届くのは `proxy_web` 上のコンテナだけ。既定の `TRUST_PROXY=uniquelocal`(プライベート IP)で nginx の `X-Forwarded-For` を信用する。

- `ports:` を追加してホストに公開しないこと(外部から偽装した `X-Forwarded-For` を送れてしまう)。
- `proxy_web` 上の他のコンテナも信用対象になる。絞る場合は `.env` に nginx コンテナの IP を `TRUST_PROXY=172.x.x.x` と書く(`docker network inspect proxy_web` で確認。nginx コンテナを作り直すと変わりうる)。

## データ

- DB: `./data/novel-backup.db`。バックアップはこのファイルをコピーする(停止中が安全。稼働中なら `sqlite3 data/novel-backup.db ".backup backup.db"`)。
- 配布 APK: `./data/apk/novel-backup.apk` に置くと `https://<ドメイン>/download` から取得できる(開発機で `npm run mobile:apk` すると開発機の `data/apk/` に出力されるので、それをサーバーの `./data/apk/` へコピーする)。

## scrapling の自動更新

既定で毎日 04:00(コンテナの `TZ`、既定 Asia/Tokyo)に scrapling の最新版を確認し、新しければ `/data/python/venvs/` に venv を作って切り替える(`.env` の `SCRAPLING_AUTO_UPDATE=false` で無効、`SCRAPLING_UPDATE_TIME=HH:mm` で時刻変更)。イメージの再ビルドは不要。詳細な手順・安全策は [05_deployment.md](05_deployment.md#scrapling-の自動更新)。

- 書き込み先は `/data`(UID 1000 で書き込み可、ホストの `./data` に永続化)だけ。root 権限もイメージの変更も不要で、コンテナを作り直しても `./data/python` が残るため更新済みの版が引き継がれる。イメージに入っている pip インストール済みの版は常にフォールバック。
- イメージを再ビルドしたとき: overlay の scrapling がイメージ同梱の版以下、または Python のマイナーバージョンが違う場合は、起動時に overlay を自動で破棄してイメージの版に戻る(古い overlay が新しいイメージを上書きしない)。
- venv 2 世代分のディスク(数百 MB 程度)を `./data/python` に使う。
- 無審査の第三者コードを毎日取り込む点に注意(wheel のみ・self-test・ロールバックはあるが悪意ある版は防げない)。

## 更新

```bash
git pull
docker compose up -d --build
```

DB のマイグレーションは起動時に自動で実行される。
