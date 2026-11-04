# novel-backup サーバー(API + バックアップ)。Node 26 + Python 3.12(スクレイパー)
# ビルド: docker compose build / 単体: docker build -t novel-backup .

# ---- ビルド(TypeScript → dist、本番依存のみの node_modules) ----
FROM node:26-trixie-slim AS build
WORKDIR /app
# workspaces 構成のため、lock とすべての package.json を先にコピーして依存をキャッシュする
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY mobile/package.json mobile/
RUN npm ci --workspace server --include-workspace-root --ignore-scripts
COPY tsconfig.base.json ./
COPY server/tsconfig.json server/
COPY server/src server/src
RUN npm run build -w server \
 && npm ci --workspace server --omit=dev --ignore-scripts

# ---- 実行 ----
FROM python:3.12-slim-trixie
ENV NODE_ENV=production \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data \
    BACKUP_PYTHON_BIN=python \
    TZ=Asia/Tokyo

# Node は同じ Debian(trixie)ベースの公式イメージからバイナリだけ持ってくる
COPY --from=build /usr/local/bin/node /usr/local/bin/node

WORKDIR /app
COPY server/python/requirements.txt server/python/
RUN pip install -r server/python/requirements.txt

COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/server/package.json server/
COPY --from=build /app/server/dist server/dist
COPY server/python/scrape_with_scrapling.py server/python/

# root で動かさない。/data はボリューム(ホストの ./data)で UID 1000 が書き込める必要がある
RUN useradd --uid 1000 --create-home --shell /usr/sbin/nologin app \
 && mkdir -p /data && chown app:app /data
USER app

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

WORKDIR /app/server
CMD ["node", "--no-warnings", "dist/index.js"]
