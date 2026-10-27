# 09. モバイルアプリ:表示テーマ統一と広告非表示

[08_mobile_app.md](08_mobile_app.md) の InAppBrowser で直接表示している 3 サイトに、アプリ側から CSS を注入して見た目を統一する。

## 決定事項

| 項目 | 決定 |
|---|---|
| 適用範囲 | **サイト全体**(作品ページ・目次・話ページ・ランキング/検索等すべて)。3 サイトのホストのみ |
| テーマ | ライト / セピア / ダーク を設定画面で切替(既定 ライト)。配色は Web 版リーダー(`client/src/components/EpisodeReader.vue`)と揃える |
| 本文表示 | 話ページの本文は文字サイズ(5 段階程度)、行間、明朝/ゴシックを設定で変更可能 |
| 広告 | サイト別セレクタで `display:none !important`。設定で ON/OFF(既定 ON) |
| 設定保存 | `@capacitor/preferences`(端末ローカル。サーバー保存は不要) |
| 注入方法 | `loadstop` で `insertCSS({code})`。チラつき軽減のため `loadstart` でも背景色だけの最小 CSS を試行(失敗しても無害に) |

## CSS の構成(`mobile/src/theme/`)

- `palette.ts`:テーマ毎の色トークン `{ bg, surface, fg, muted, link, linkVisited, border, accent }`
- `base.css.ts`:全サイト共通の強制配色
  - `html, body` に `bg` / `fg`
  - 主要なブロック要素(`div, section, article, header, footer, nav, main, aside, ul, ol, li, table, tr, td, th, dl, dt, dd, p, span, h1-h6, form, fieldset`)の `background-color` を `transparent !important`、`color: inherit !important`、`border-color: border`
  - `a` は `link`、`a:visited` は `linkVisited`
  - `input, select, textarea, button` は `surface` 背景 + `fg` 文字 + `border`
  - **`img, video, svg, canvas, picture` と背景画像は変更しない**(`background-image` は消さない。アイコン/画像が消えないよう、`background` ショートハンドではなく `background-color` のみ上書き)
  - `::selection` もテーマ色
- `sites/narou.css.ts`, `sites/kakuyomu.css.ts`, `sites/hameln.css.ts`:サイト固有の補正
  - ヘッダー/ナビの帯、ボタン、ルビ、傍点、本文コンテナ幅、前書き/後書きの区切り
  - 本文コンテナに文字サイズ・行間・フォントを適用
  - 広告セレクタ(配列で定義。広告非表示 ON の時のみ CSS 化)
- 本文コンテナのセレクタは既存サーバーアダプタ(`server/src/sites/*.ts` の `*_SELECTORS`)を参考にする。

## 広告セレクタの調査

- なろう・カクヨムは実ページ(作品・目次・話・トップ/ランキング各 1 ページ程度、通常の GET のみ)を取得し、広告枠の要素(`ins.adsbygoogle`、広告用 iframe、`[id^="div-gpt-ad"]`、サイト固有の広告コンテナ class)を特定する。
- ハーメルンはサーバーから取得できないため、汎用セレクタ(`ins.adsbygoogle`, `iframe[src*="doubleclick"]`, `iframe[src*="googlesyndication"]`, `[id^="div-gpt-ad"]`, `[id*="google_ads"]`)+ 推測。実機で確認後に調整する前提。
- 過剰に消して本文やナビを壊さないこと(`[class*="ad"]` のような広すぎるセレクタは禁止)。

## 設定画面(mobile)

既存の設定画面に「表示」セクションを追加:テーマ(3 択)、文字サイズ、行間、フォント、広告非表示(トグル)。プレビュー用の短いサンプル文を表示。変更は次回ページ読み込みから反映(開いている InAppBrowser には即時再注入できれば尚可)。

## ★ボタンとの関係

★ボタンとトーストの見た目もテーマ色に合わせる。

## 完了条件

- `npm run typecheck`, `npm run build` 成功、`npm run mobile:sync` と `npm run mobile:apk` 成功。
- 生成 CSS の単体テスト(テーマ毎にトークンが入る、広告 OFF で広告セレクタが含まれない、画像系要素を上書きしない)を mobile に vitest で追加(または server のテストと同様の仕組み)。
- 実機確認は利用者がエミュレーターで行う。

## 実装メモ

- **構成**: `mobile/src/theme/` に `palette.ts`(3 テーマ。配色は EpisodeReader の `--r-bg/--r-fg/--r-line` と同値、ほかは追加トークン)、`settings.ts`(`DisplaySettings`・サニタイズ・文字サイズ px 表)、`base.css.ts`、`sites/{narou,kakuyomu,hameln}.css.ts`、`index.ts`(`buildCss(hostname, settings)` / `buildMinimalCss`)、`storage.ts`(Preferences キー `display`、JSON)。生成関数は純粋で、vitest(`mobile/test/theme.test.ts`)で検証。
- **表示設定**: テーマ 3 / 文字サイズ 5 段階(15,17,19,22,26px。既定 19) / 行間 1.5,1.7,1.9,2.2(既定 1.9) / 明朝・ゴシック(既定 明朝) / 広告非表示(既定 ON)。
- **注入**: `Home.vue` が `loadstart`(背景色のみ)と `loadstop`(完全な CSS)で `insertCSS({code})`。対象は `e.url` のホストが 3 サイトのときのみ(それ以外は空文字で何もしない)。設定が変わると開いている IAB に新 CSS を再注入(後勝ち。広告 ON→OFF の戻しは次回読み込みから)。設定画面は通常ブラウザを閉じてから開くため即時反映はあくまで補助。
- **強制配色**: ブロック要素は `background-color:transparent !important; color:inherit !important`。`background` ショートハンド・`background-image`・img/video/svg/canvas/picture は一切指定しない(テストで担保)。
- **★/トースト**: `#nb-star` / `#nb-toast` を ID セレクタ + `!important` でテーマの accent 色に(ブロック要素の transparent 規則に勝つため)。エラー時は `data-kind="error"` で danger 色(`inject.ts` がトースト表示時に属性を設定)。
- **広告セレクタ(実ページ確認 2026-10、通常の GET を計 10 回程度)**
  - なろう(トップ/ランキング/作品/話で確認): `.c-ad`(`.c-ad--rectangle` `--mobile` `--mobile-bigbanner(-2x)` `--native` を含む)、`.c-ad-fit-disp`(ランキングの外枠)、`.c-pr`(「PR」ラベル)。枠内は Geniee の `[data-cptid]` + GPT で、枠ごと非表示。本文 `.p-novel__text` は広告の内側に入っていないことを確認。
  - カクヨム: トップ/作品(Next.js、CSS Modules でハッシュ付き class)は `Ad_ad__<hash>`、枠 `_compactAdBox__<hash>`、安定した id `top-ad-*` / `work-ad-*`。話ページ(従来画面)は `#js-ad-episode-touch-*`(`.widget-ad-touchRectangle`)、`#episode-bottomAd-touch`、`#contentMain-nextEpisode-ad`。ランキングページには広告枠なし。`.widget-episodeBody` が広告の内側に無いことを確認。ハッシュ接尾辞が変わっても id 系で拾えるようにしている。
  - ハーメルン: 取得不可のため汎用セレクタのみ(`ins.adsbygoogle`, `iframe[src*=doubleclick|googlesyndication]`, `[id^="div-gpt-ad"]`, `[id*="google_ads"]`)。**実機で確認・調整が必要**。3 サイト共通で上記汎用セレクタも併用。
- **未検証**: ハーメルンの本文以外のレイアウト補正(`div.ss` の枠線のみ)、傍点の見た目(実ページに該当要素が無く指定していない)。
- **apk.mjs**: JAVA_HOME 未設定または JDK 22 以上なら `%USERPROFILE%\.jdks` の JDK 21 を使用(使用 JDK を表示)、ANDROID_HOME 未設定なら `%LOCALAPPDATA%\Android\Sdk`。
