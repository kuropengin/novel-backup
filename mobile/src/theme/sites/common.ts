import { FONT_SIZES_PX, FONT_STACKS, type DisplaySettings } from "../settings";
import type { Palette } from "../palette";

export interface SiteTheme {
  id: "narou" | "kakuyomu" | "hameln";
  /** ホスト名(hostname)が対象か */
  hostPattern: RegExp;
  /** 広告コンテナのセレクタ。広告非表示 ON の時のみ CSS 化する */
  adSelectors: readonly string[];
  css(p: Palette, d: DisplaySettings): string;
}

/** どのサイトでも使う汎用の広告セレクタ(広すぎるワイルドカードは使わない)。 */
export const GENERIC_AD_SELECTORS = [
  "ins.adsbygoogle",
  'iframe[src*="doubleclick"]',
  'iframe[src*="googlesyndication"]',
  '[id^="div-gpt-ad"]',
  '[id*="google_ads"]',
] as const;

/**
 * 本文コンテナへの文字サイズ・行間・フォント適用。
 * containers の各要素とその p/div 子孫に適用し、ルビ(rt)は相対サイズに戻す。
 */
export function readerCss(containers: readonly string[], p: Palette, d: DisplaySettings): string {
  const px = FONT_SIZES_PX[d.fontSize - 1];
  const sel = containers.flatMap((c) => [c, `${c} p`]).join(",");
  const rt = containers.map((c) => `${c} rt`).join(",");
  return [
    `${sel}{font-size:${px}px !important;line-height:${d.lineHeight} !important;font-family:${FONT_STACKS[d.font]} !important;overflow-wrap:anywhere;}`,
    `${rt}{font-size:0.5em !important;line-height:1 !important;color:${p.muted} !important;}`,
  ].join("\n");
}
