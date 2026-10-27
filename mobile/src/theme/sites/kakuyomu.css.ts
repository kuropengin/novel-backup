import type { SiteTheme } from "./common";
import { GENERIC_AD_SELECTORS, readerCss } from "./common";

/** 本文コンテナ(KAKUYOMU_SELECTORS と同じ) */
const BODY = [".widget-episodeBody"];

/**
 * 広告セレクタ(2026-10 実ページで確認: トップ・ランキング・作品ページ・話ページ)
 *  - Next.js 画面(トップ/作品): CSS Modules のため class にハッシュ接尾辞が付く。`Ad_ad__xxxx` と枠 `*_compactAdBox__xxxx`、
 *    id が `top-ad-compact-*` / `work-ad-compact-*`(安定)。接尾辞が変わっても id 側で拾える。
 *  - 話ページ(従来画面): `#js-ad-episode-touch-*`(`.widget-ad-touchRectangle`)、`#episode-bottomAd-touch`、`#contentMain-nextEpisode-ad`
 */
export const KAKUYOMU_AD_SELECTORS = [
  '[class^="Ad_ad__"]',
  '[class*=" Ad_ad__"]',
  '[class*="_compactAdBox__"]',
  '[id^="top-ad-"]',
  '[id^="work-ad-"]',
  '[id^="js-ad-episode-"]',
  ".widget-ad-touchRectangle",
  "#episode-bottomAd-touch",
  "#contentMain-nextEpisode-ad",
  ...GENERIC_AD_SELECTORS,
] as const;

export const kakuyomu: SiteTheme = {
  id: "kakuyomu",
  hostPattern: /(^|\.)kakuyomu\.jp$/,
  adSelectors: KAKUYOMU_AD_SELECTORS,
  css(p, d) {
    return [
      // ヘッダー/ナビの帯(クラス名はハッシュ付きのため要素名で指定)
      `header,#worksEpisodesEpisodeHeader,#contentMain-header{background-color:${p.surface} !important;border-color:${p.border} !important;}`,
      `button[class*="ui-button"]{background-color:${p.surface} !important;color:${p.fg} !important;border:1px solid ${p.border} !important;}`,
      `.widget-episodeBody{max-width:46em;margin-left:auto;margin-right:auto;}`,
      readerCss(BODY, p, d),
    ].join("\n");
  },
};
