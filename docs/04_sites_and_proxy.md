# 04. サイトアダプタと Proxy

## 共通型 (`server/src/sites/types.ts`)

```ts
export type SiteId = 'hameln' | 'narou' | 'kakuyomu';

export interface TocEntry {
  episodeKey: string;        // サイト上の話ID
  index: number;             // 0 始まりの並び順
  title: string;
  chapter?: string;          // 所属する章タイトル(あれば)
  publishedAt?: string;      // ISO8601
  updatedAt?: string;        // ISO8601(改稿日。無ければ publishedAt)
}

export interface NovelMeta {
  site: SiteId;
  novelKey: string;
  url: string;
  title: string;
  author: string;
  authorUrl?: string;
  synopsis: string;          // プレーンテキスト(改行保持)
  tags: string[];
  status: 'ongoing' | 'completed' | 'unknown';
  isShortStory: boolean;     // 短編(目次なし1話)
}

export interface NovelInfo extends NovelMeta {
  episodes: TocEntry[];
}

export interface EpisodeContent {
  episodeKey: string;
  title: string;
  prefaceHtml?: string;      // 前書き(サニタイズ済み)
  bodyHtml: string;          // 本文(サニタイズ済み)
  afterwordHtml?: string;    // 後書き(サニタイズ済み)
}

export interface SiteAdapter {
  site: SiteId;
  displayName: string;
  /** Proxy 許可ホスト。先頭が既定ホスト */
  hosts: string[];
  /** 元サイト URL を解析。作品/話ページでなければ null */
  parseUrl(url: URL): { novelKey: string; episodeKey?: string } | null;
  novelUrl(novelKey: string): string;
  episodeUrl(novelKey: string, episodeKey: string): string;
  fetchNovel(novelKey: string): Promise<NovelInfo>;
  fetchEpisode(novelKey: string, episodeKey: string): Promise<EpisodeContent>;
}

export class SiteNotFoundError extends Error {} // 作品/話が存在しない(404 等)
```

**短編**は `episodes` を 1 件(`episodeKey: "short"`, title = 作品タイトル)として返し、`fetchEpisode(key, "short")` で作品ページ本体から本文を取る。

## 外部取得 (`http/politeFetch.ts`)

- `politeFetch(url, opts?)` → `{ status, url(最終), headers, text }`
- ホスト毎に直列キュー。前回リクエスト完了から `requestIntervalMs`(設定値、既定 1500ms)空ける。ライブ閲覧(ユーザー操作)は `priority: 'interactive'` でキュー先頭に入れ、間隔は 300ms に短縮してよい。
- タイムアウト 20 秒、`429`/`5xx`/ネットワークエラーは指数バックオフで最大 3 回リトライ(`Retry-After` 尊重)。
- `404`/`410` は `SiteNotFoundError`。
- 既定ヘッダ:`User-Agent`(config)、`Accept-Language: ja`。
- サイト別 Cookie:ハーメルンは閲覧に必要な Cookie(例:年齢確認系)があればアダプタから付与。なろうの `over18=yes` は不要(ノクターンは非対応)。

## サイト別メモ(実装時に必ず実ページを WebFetch で確認し、セレクタを確定すること)

DOM は変更されうるので、**セレクタは各アダプタ冒頭に定数としてまとめ、複数候補をフォールバックで持つ**。

### ハーメルン (`syosetu.org`)
- 作品:`https://syosetu.org/novel/{id}/` 、話:`https://syosetu.org/novel/{id}/{n}.html`(n は 1 始まり)
- novelKey = 数値 ID、episodeKey = `n`。
- 目次ページに各話の投稿日時(改稿があれば改稿日時が title 属性等に出る)。短編は作品ページに本文が直接ある。
- 本文 `#honbun`、前書き `#maegaki`、後書き `#atogaki`(要確認)。
- 年齢確認や Cloudflare チャレンジで HTML が返らない場合は明示的なエラー(`SiteBlockedError`)にする。

### 小説家になろう (`ncode.syosetu.com`)
- 作品:`https://ncode.syosetu.com/{ncode}/`、話:`https://ncode.syosetu.com/{ncode}/{n}/`
- novelKey = ncode 小文字、episodeKey = `n`。
- **メタ情報は公式 API を優先**:`https://api.syosetu.com/novelapi/api/?out=json&ncode={ncode}`(title, writer, story, keyword, end, general_all_no, novel_type(1=連載,2=短編), general_lastup, novelupdated_at)。
- 目次は HTML(`?p=2` 以降のページング、1 ページ 100 話)。各話の掲載日と改稿日(`改稿` 表示の title 属性)を取得。
- 本文:2024 年以降の新レイアウト `.p-novel__body` 内の `.js-novel-text`(前書き/本文/後書きの 3 ブロック。`p-novel__text--preface` / `--afterword`)。旧レイアウト `#novel_p` / `#novel_honbun` / `#novel_a` もフォールバックで持つ。
- 短編は `https://ncode.syosetu.com/{ncode}/` に本文。

### カクヨム (`kakuyomu.jp`)
- 作品:`https://kakuyomu.jp/works/{workId}`、話:`https://kakuyomu.jp/works/{workId}/episodes/{episodeId}`
- novelKey = workId、episodeKey = episodeId。
- 作品ページは Next.js。`<script id="__NEXT_DATA__">` の JSON (`props.pageProps.__APOLLO_STATE__`) から Work / TableOfContentsChapter / Episode を辿って目次・章・公開日時を取得する。
- 本文:`.widget-episodeBody`。タイトル `.widget-episodeTitle`。
- カクヨムに前書き/後書き概念はないので undefined。

## 本文サニタイズ (`sites/sanitize.ts`)

`sanitize-html` で許可タグ:`p br ruby rb rt rp span em strong b i u s small sub sup hr div img a h1-h6`。
許可属性:`img[src alt width height]`, `a[href]`, `span[class]`(傍点用 class のみ残す等は任意)。
`img src` は絶対 URL 化した上で **`/proxy/img?url=...` 形式に書き換えない**(バックアップ本文は元 URL を保持し、表示時にクライアントが `/proxy/img` 経由にする)。
`id` 属性(`L1` 等)は除去してよい。

## ブラウズ用 HTML 書き換え Proxy (`/proxy/:site/*`)

- 例:`/proxy/narou/ncode.syosetu.com/n1234ab/1/` → `https://ncode.syosetu.com/n1234ab/1/`
  - パス形式:`/proxy/{site}/{host}/{path}?{query}`。`host` は該当アダプタの `hosts` に含まれるもののみ許可(**オープンプロキシ禁止**)。
  - なろうは `yomou.syosetu.com`(ランキング/検索)、`ncode.syosetu.com`、`syosetu.com`(トップ) を許可。
  - ハーメルンは `syosetu.org`。カクヨムは `kakuyomu.jp`。
- GET のみ(フォームは GET 送信のもののみ動作。POST フォームは action を無効化)。
- `text/html` の場合のみ cheerio で書き換え:
  - `<script>`, `<noscript>` 内容展開は不要、`<iframe>`, `<meta http-equiv="refresh">`, インラインイベント属性 `on*` を除去。
  - `a[href]`, `form[action]`, `link[href]`, `img[src|srcset]`, `source[srcset]` を絶対 URL 化 → 許可ホストなら `/proxy/{site}/{host}/...` に、許可外ホストのリンクは `target="_blank" rel="noopener noreferrer"` で元 URL のまま(画像/CSS など許可外静的リソースは `/proxy/asset?url=...` へ)。
  - `<base>` を除去。`<head>` 末尾に小さな `<style>` を注入しても良い(広告領域の非表示など)。
- それ以外の content-type(CSS/画像/フォント)はそのままストリーム返却。CSS 内の `url()` は書き換え不要(`/proxy/asset` 経由で返す CSS は相対参照が壊れるため、CSS だけは `url(...)` を絶対→`/proxy/asset?url=` に書き換える)。
- `/proxy/asset?url=...` と `/proxy/img?url=...`:**静的リソース専用**。3 サイトと各サイトの CDN ドメイン(実装時に確認したもののみをホワイトリスト化)に限定。画像は `Cache-Control: public, max-age=86400`。
- レスポンスヘッダ:`Content-Security-Policy: script-src 'none'; frame-ancestors 'self'`、`X-Frame-Options` 等の元ヘッダは捨てる。`Set-Cookie` は転送しない。
- 書き換え Proxy の HTTP 取得も `politeFetch(priority:'interactive')` を使う。

### クライアントとの連携

クライアントは iframe(同一 origin)の `load` イベントで `iframe.contentWindow.location.pathname` を読み、`/api/live/resolve?url=<path>` で作品/話ページか判定 → ツールバーに「ブックマーク」「リーダーで開く」を表示。

## 実装メモ(Phase 2 で確認・確定した事項)

- `fetchNovel(novelKey, opts?)` / `fetchEpisode(novelKey, episodeKey, opts?)` は `opts.priority`('interactive' | 'normal')を受け取る。`SiteBlockedError`(reason: challenge/age-gate)と `SiteParseError` を `sites/types.ts` に追加。`resolveUrl(url|path)` / `isAllowedHost(site, host)` / `siteForHost(host)` は `sites/index.ts`。
- `politeFetch` は `createPoliteFetcher(deps)` でテスト可能。実行時は `configurePoliteFetch({ getIntervalMs: () => getSettings(db).requestIntervalMs })` を起動時に呼ぶ。ボット判定(`cf-mitigated: challenge` / 403・503 + "Just a moment")は `SiteBlockedError`、その他 4xx は `HttpError`(リトライなし)。
- **ハーメルン接続(Cookie/UA)**: 設定 `hamelnCookie` / `hamelnUserAgent`。`PoliteFetcherDeps.getHamelnAuth`(index.ts で `getSettings(db)` から都度取得)が返す値を、宛先ホストが `syosetu.org` 系(`isHamelnHost`。`syosetu.com` は対象外)の場合のみ `Cookie` / `User-Agent` ヘッダに付与する。Cookie 付与時は redirect を手動で辿り、他ホストへのリダイレクト先には付与しない。上流の Set-Cookie は無視。/proxy 経由も同じ経路。制限: cf_clearance は取得ブラウザの IP と UA に紐付き期限切れになるため、同一ネットワークでの運用と定期的な更新が必要。未設定/期限切れ時のブロックエラーは設定画面への誘導メッセージになる。
- 日時はすべて UTC ISO8601(サイト表示の JST から変換)。
- **なろう**(2026-10 実確認): API は `end=0` が完結済(または短編)、`1` が連載中。`novel_type=2` が短編。目次は 100 話/ページで `.c-pager__item--last` の `?p=N` が最終ページ。章見出しは次ページに繰り返されないため前ページ末尾の章を引き継ぐ。前書き/後書きは `.p-novel__text--preface` / `--afterword`、空(`<br>` のみ)の場合は undefined。
- **カクヨム**(実確認): `Work:{id}.tableOfContentsV2` → `TableOfContentsChapter.episodeUnions` → `Episode{id,title,publishedAt}`。`chapter` は `Chapter{level 1|2, title}`。第 2 階層は「大章 / 小章」として `chapter` に格納。改稿日は取得不可のため `updatedAt = publishedAt`。**カクヨムに短編専用ページは無いため `isShortStory` は常に false**(1 話の作品も通常の話 ID を `episodeKey` に持つ)。著者表示名は `UserAccount.activityName`(`name` は URL 用 ID → `/users/{name}`)。
- **ハーメルン**: 開発環境から Cloudflare チャレンジ(403)で実ページを取得できず、**セレクタは未検証**(推定。`hameln.ts` 冒頭の `HAMELN_SELECTORS` 参照)。ブロック時は `SiteBlockedError('challenge')`。取得可能な環境で `try-adapter` により要確認。

## 実装メモ(Phase 3 で確定した事項)

- **Proxy 許可ホスト(静的リソース = `/proxy/asset`・`/proxy/img`)**: 3 サイトの `hosts` に加え `static.syosetu.com`(なろう CSS/画像)、`*.mitemin.net`(なろう本文の挿絵)、`cdn-static.kakuyomu.jp`(カクヨム)、`*.syosetu.org`(ハーメルン。実ページ未確認のため推定)。`proxy/rewrite.ts` の `EXTRA_ASSET_HOSTS`。IP リテラル・ポート・認証情報付き・http(s) 以外は拒否。リダイレクト後のホストも再検査。
- 許可外ホストの静的リソース(広告画像等)は書き換えず元 URL のまま(`/proxy/asset` はホワイトリスト限定のため)。`<noscript>` は展開し、`<iframe>/<object>/<embed>/<base>/<template>` を除去。POST フォームは `/proxy/post-disabled`(405)へ。GET フォームは action を path のみに書き換え。
- `/proxy/asset`・`/proxy/img` は `Cache-Control: private, max-age=86400`(認証付きのため public ではなく private)。`CSP: script-src 'none'; sandbox`。img は `image/*` のみ、asset は HTML/JS/XML 系を 415。
- `politeFetch` に `binary: true` オプションを追加(結果に `body: Buffer`)。Proxy は全て `priority: 'interactive'`。
- Proxy が取得失敗した場合、HTML リクエストにはエラー説明 HTML(502/404)を返す(iframe が空白にならない)。ハーメルン等のブロック時は「ボット対策によりブロック」と表示。
- live API の JSON(02_server.md の補足): `GET /api/live/sites`、`GET /api/live/resolve?url=` → `{site, novelKey, episodeKey?, bookmarked, bookmarkId}`、`GET /api/live/:site/novels/:novelKey` → `NovelInfo & {bookmarked, bookmarkId}`、`.../episodes/:episodeKey` → `EpisodeContent & {site, novelKey, novelTitle, chapter, index, total, url, prevEpisodeKey, nextEpisodeKey, bookmarked, bookmarkId}`。パラメータ名は `novelId` ではなく `novelKey`/`episodeKey`。`SiteNotFoundError`→404、`SiteBlockedError`→502 `site_blocked`、その他上流エラー→502 `upstream_error`。
- bookmarks API: `POST {site,novelKey}|{url}` → 201 `{bookmark, created:true}`(既存は 200 `created:false`)。メタ取得がブロックされても空メタで登録する(`novels.title=''`。バックアップが後で補完)。一覧は `episodeCount/unreadCount/lastBackupAt` を含む。
- `backup/queue.ts` の `enqueueNovelBackup(novelId, trigger)` は Phase 3 では no-op だったが、Phase 4 で scheduler に接続済み。
