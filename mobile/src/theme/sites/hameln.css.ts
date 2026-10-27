import type { SiteTheme } from "./common";
import { GENERIC_AD_SELECTORS, readerCss } from "./common";

/** 本文コンテナ(HAMELN_SELECTORS と同じ) */
const BODY = ["#honbun", "#maegaki", "#atogaki"];

/**
 * 広告セレクタ: ハーメルンはこの環境から取得できず実ページ未確認のため、汎用セレクタのみ。
 * 実機で広告が残る場合は、ここへ追加する。
 */
export const HAMELN_AD_SELECTORS = [...GENERIC_AD_SELECTORS] as const;

export const hameln: SiteTheme = {
  id: "hameln",
  hostPattern: /(^|\.)syosetu\.org$/,
  adSelectors: HAMELN_AD_SELECTORS,
  css(p, d) {
    return [
      `div.ss{border-color:${p.border} !important;}`,
      `#honbun,#maegaki,#atogaki{max-width:46em;margin-left:auto;margin-right:auto;}`,
      readerCss(BODY, p, d),
      `#maegaki,#atogaki{border-left:3px solid ${p.border} !important;padding-left:10px;opacity:0.9;}`,
    ].join("\n");
  },
};
