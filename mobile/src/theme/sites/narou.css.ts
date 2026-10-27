import type { SiteTheme } from "./common";
import { GENERIC_AD_SELECTORS, readerCss } from "./common";

/** 本文コンテナ(server/src/sites/narou.ts の NAROU_SELECTORS と同じ。新旧レイアウト) */
const BODY = [".p-novel__text", "#novel_honbun", "#novel_p", "#novel_a"];

/**
 * 広告セレクタ(2026-10 実ページで確認: トップ・ランキング・作品ページ・話ページ)
 *  - `.c-ad`(modifier 付き `.c-ad--rectangle/--mobile/--mobile-bigbanner(-2x)/--native` を含む)と、ランキングの外枠 `.c-ad-fit-disp`
 *  - `.c-pr`(広告枠内の「PR」ラベル)
 *  - 枠内は Geniee の `data-cptid` div + GPT。枠ごと消すので個別指定は不要
 */
export const NAROU_AD_SELECTORS = [".c-ad", ".c-ad-fit-disp", ".c-pr", ...GENERIC_AD_SELECTORS] as const;

export const narou: SiteTheme = {
  id: "narou",
  hostPattern: /(^|\.)syosetu\.com$/,
  adSelectors: NAROU_AD_SELECTORS,
  css(p, d) {
    return [
      // ヘッダー/ナビの帯
      `.c-menu,.c-menu__body,.c-follow-header{background-color:${p.surface} !important;border-bottom:1px solid ${p.border} !important;}`,
      // ボタン類
      `.c-button,.c-pager__item a,.c-pager__item{background-color:${p.surface} !important;color:${p.fg} !important;border-color:${p.border} !important;}`,
      // 本文領域
      `.p-novel__body{max-width:46em;margin-left:auto;margin-right:auto;}`,
      readerCss(BODY, p, d),
      // 前書き/後書きの区切り
      `.p-novel__text--preface,.p-novel__text--afterword,#novel_p,#novel_a{border-left:3px solid ${p.border} !important;padding-left:10px;opacity:0.9;}`,
      `.p-novel__text--afterword,#novel_a{margin-top:24px;}`,
    ].join("\n");
  },
};
