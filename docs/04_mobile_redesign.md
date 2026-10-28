# 04. モバイルアプリ リデザイン(X ダークテーマ風)

[03_mobile_app.md](03_mobile_app.md) のアプリを、X(Twitter)のダークテーマを参考に作り直す。

## 決定事項

| 項目 | 決定 |
|---|---|
| サイト表示 | InAppBrowser を廃止し、**自作 Capacitor Android プラグイン `SiteView`** でアプリ画面内(上バーと下バーの間)にネイティブ WebView を埋め込む |
| バー自動非表示 | X と同じく、下スクロール開始で上下バーを隠しコンテンツのみ表示、上スクロールで再表示。サイト閲覧中もアプリ内リスト画面でも同じ挙動 |
| 閲覧履歴 | サーバー DB に保存(ユーザー毎)。オフライン時は端末に溜めて復帰後に送信 |
| オフライン保存・バックアップ・更新日 | **今回はデザインのみ**(アイコン・並べ替え項目・お知らせ枠)。中身は後日 |
| 自動取得 | 行わない。アプリは利用者が操作する通常のブラウザ。チャレンジ突破・UA/指紋偽装もしない |

## 配色(アプリ UI のみ。サイトの見た目は変えない)

既定はダーク(黒に近い灰色)。ライトも選べる。CSS 変数で定義。

| token | dark | light |
|---|---|---|
| `--bg` | `#16181c` | `#ffffff` |
| `--surface` | `#1e2024` | `#f7f9f9` |
| `--elevated` | `#272a30` | `#ffffff` |
| `--border` | `#2f3336` | `#eff3f4` |
| `--fg` | `#e7e9ea` | `#0f1419` |
| `--muted` | `#8b98a5` | `#536471` |
| `--accent` | `#1d9bf0` | `#1d9bf0` |
| `--danger` | `#f4212e` | `#f4212e` |
| `--star` | `#ffd400` | `#ffad1f` |

- バーは半透明 + `backdrop-filter: blur`(X 風)。フォントは system-ui。角丸・余白・区切り線は X に倣う。アイコンはインライン SVG(外部依存なし)。
- ステータスバー/ナビゲーションバーの色もテーマに合わせる(`@capacitor/status-bar` 可)。

## 画面構成

```
┌ 上バー ───────────────────────────┐
│ (ユーザーアイコン)   [アプリアイコン]   [Aa][テーマ] │
├──────────────────────────────────┤
│  メイン(各タブ画面 or SiteView)                │
├ 下バー ───────────────────────────┤
│  ホーム  お気に入り  (★大)  履歴  お知らせ        │
└──────────────────────────────────┘
```

### 上バー
- **左**:ユーザーアイコン(ユーザー名の頭文字の丸アバター)。タップで**サイドメニュー**を左から展開:ユーザー名・ロール、設定(サーバー URL / パスワード変更)、ユーザー管理(admin のみ)、ログアウト。
- **中央**:アプリアイコン。
- **右**:「Aa」= 本文表示設定シート(フォント 明朝/ゴシック、文字サイズ 5 段階、行間)— 既存の本文 CSS 注入機能をそのまま使う。テーマ切替ボタン(ダーク/ライト、**アプリ UI のみ**)。

### 下バー(左から)
1. **ホーム**
2. **お気に入り一覧**
3. **お気に入り追加 ★**(他より大きい円形ボタン)
   - SiteView 表示中かつ現在の URL が作品/話ページの時のみ有効。それ以外は無効表示。
   - 未登録 → 保存(タイトル等は既存の注入スクリプトで取得)。登録済み → 星を塗りつぶし表示。押すと「お気に入りを解除しますか?」確認(`@capacitor/dialog` のネイティブ確認)→ OK で解除。
4. **閲覧履歴**
5. **お知らせ**(未読があればバッジ)

### ホーム
- サイトボタン 3 つ(なろう / カクヨム / ハーメルン。各サイトの色のアクセント付きカード)→ SiteView で開く。
- **閲覧作品**:履歴から作品毎の最新を新しい順に。各行「作品名 / 最後に読んだ話タイトル / 相対時刻」。タップで最後に読んだ話の URL を SiteView で開く。

### SiteView(サイト閲覧)
- ホームタブ内で開く。開いている間もタブ切替可能(SiteView は非表示にして状態を保持)。ホームタブを再タップ → SiteView を閉じてホームへ。
- Android 戻るボタン:サイドメニュー/シートが開いていれば閉じる → SiteView で戻れれば戻る → SiteView を閉じる → (ホーム以外のタブならホームへ)→ アプリ終了。
- ページ読み込み完了毎に:本文表示設定 CSS を注入、ページ情報(作品名・話タイトル)を取得して作品/話ページなら閲覧履歴を送信、★ の状態を更新。
- 既存の「ページ内に注入するフローティング★」は廃止(下バーの ★ に一本化)。

### お気に入り一覧
- 上部:検索バー(タイトル・作者・サイトで絞り込み)、並べ替えボタン(シート:追加日 / 更新日 / タイトル / サイト × 昇順・降順。**更新日はデータが無いため追加日で代用し「未対応」表記**)。
- リスト行:サイトバッジ、タイトル、作者、追加日。右側に状態アイコン 2 つ:**バックアップ**・**オフライン保存**(今回は常に「なし」のグレー表示)。
- タップで作品 URL を SiteView で開く。左スワイプまたは長押しで削除(確認あり)。
- **オフライン時**(`@capacitor/network`)は「オフライン保存済みのみ表示」→ 今回は空状態メッセージ。

### 閲覧履歴
- 検索バー、表示切替セグメント「エピソード毎 / 作品毎」。
- エピソード毎:各話の閲覧(作品名・話タイトル・時刻)。作品毎:作品単位で集約(最終閲覧話・閲覧話数)。
- お気に入り未登録の作品も表示。タップで SiteView。長押しで履歴削除。

### お知らせ
- 端末保存完了・バックアップ完了などの通知一覧(端末内に保存、既読管理)。今回は発生源がないため空状態表示 + 通知ストア API のみ用意(`notify({kind, title, body})`)。

### 共通の挙動
- 下スクロール開始(しきい値 ~8px)で上下バーをスライドアウト、上スクロールで戻す。SiteView ではネイティブ側のスクロールイベントで判定し、WebView の表示領域もバーに合わせて広げる/戻す(アニメーション)。
- サイドメニュー・シート表示中は SiteView を一時的に非表示(ネイティブビューは HTML の上に描画されるため)。

## ネイティブプラグイン `SiteView`(Android, Java)

アプリ本体の WebView(Capacitor)の上に、ネイティブ WebView を矩形で重ねる。

```ts
interface SiteViewPlugin {
  open(o: { url: string; top: number; bottom: number }): Promise<void>; // top/bottom は CSS px のインセット
  close(): Promise<void>;
  setVisible(o: { visible: boolean }): Promise<void>;
  setInsets(o: { top: number; bottom: number; animate?: boolean }): Promise<void>;
  navigate(o: { url: string }): Promise<void>;
  goBack(): Promise<{ wentBack: boolean }>;
  reload(): Promise<void>;
  getState(): Promise<{ open: boolean; url: string; title: string; canGoBack: boolean }>;
  evaluate(o: { code: string }): Promise<{ result: string }>;   // evaluateJavascript、結果は JSON 文字列
  insertCss(o: { code: string }): Promise<void>;
  addListener(e: 'pageStarted' | 'pageFinished', cb: (d: { url: string; title: string; canGoBack: boolean }) => void): Promise<PluginListenerHandle>;
  addListener(e: 'scroll', cb: (d: { y: number; dy: number }) => void): Promise<PluginListenerHandle>;
}
```

- WebView 設定:JavaScript 有効、DOM storage 有効、Cookie 永続(サイトのログイン・Cloudflare 通過状態を保持)、既定 UA(変更しない)、`target=_blank` は同じ WebView で開く、3 サイト以外のホスト/スキーム(mailto:, tel:, intent: 等)へは遷移しない。メインフレームの `shouldOverrideUrlLoading`(リダイレクト・`window.open`・`target=_blank` も同じ経路。`supportMultipleWindows=false` なので同一 WebView に流れる)で遷移を止め、イベント `externalLink {url}` を送るだけで自動では何も開かない。保険として `onPageStarted` で許可外 URL を検知したら `stopLoading` → 戻れれば `goBack` → `externalLink`。サブフレーム(Cloudflare チャレンジ iframe 等)は対象外。許可リスト(`syosetu.org`/`syosetu.com`/`kakuyomu.jp` とそのサブドメイン)は Java の `ALLOWED_HOST_SUFFIXES` と TS の `logic/sites.ts` に同内容で置き、一致させる。JS 側(`Shell.vue`)はネイティブ確認ダイアログ(URL は長ければ切り詰め)を出し、OK のとき `openExternal({url})` を呼ぶ(1 秒以内の同一 URL の重複イベントは無視)。`openExternal` は http/https/mailto/tel のみ `ACTION_VIEW` で起動し、他(`intent:`/`javascript:` 等)は reject、開けるアプリが無ければ明示エラー(トースト表示)。`intent:` は `browser_fallback_url`(http/https)があればそれを開き、無ければ「開けません」と表示。
- dp ↔ CSS px 換算に注意(CSS px = dp)。システムバーのインセットも考慮。

## サーバー:閲覧履歴 API

```sql
CREATE TABLE history (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  site TEXT NOT NULL, novel_key TEXT NOT NULL,
  episode_key TEXT NOT NULL DEFAULT '',        -- 作品ページは ''
  novel_title TEXT NOT NULL DEFAULT '', episode_title TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL,
  viewed_at TEXT NOT NULL,
  UNIQUE (user_id, site, novel_key, episode_key)
);
```

- `POST /api/history {url, novelTitle?, episodeTitle?, viewedAt?}` → `resolveUrl` で site/novelKey/episodeKey を確定し upsert(`viewed_at` 更新、空でないタイトルで上書き)。作品/話ページ以外は 400 `not_a_novel_page`。
- `GET /api/history?view=episode|novel&q=&limit=&offset=` → episode: 行そのまま新しい順。novel: 作品毎に最新の話(`episode_key != ''` を優先)・閲覧話数・最終閲覧日時。`q` は作品名/話タイトル部分一致。
- `DELETE /api/history/:id`、`DELETE /api/history?site=&novelKey=`(作品単位)、`DELETE /api/history`(全消去)。
- お気に入り:`GET /api/bookmarks` に `q`, `sort=added|updated|title|site`, `order=asc|desc` を追加(`updated` は当面 `added` と同じ)。`GET /api/bookmarks/lookup?url=` → `{bookmarked, bookmarkId}`(★状態用)。
- 履歴送信は 1 ページ読み込みにつき 1 回。オフライン時はキューに積み、復帰時に送信。

## 完了条件

- サーバー:マイグレーション、API、テスト。
- mobile:`npm run typecheck`, `npm test`, `npm run build`, `npm run mobile:sync`, `npm run mobile:apk` 成功。
- 実機確認は利用者がエミュレーターで行う。
