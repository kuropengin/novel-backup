import type { Palette } from "./palette";

/**
 * 全サイト共通の強制配色。
 * 画像・アイコンを消さないため、背景は `background-color` のみ上書きし(`background` ショートハンド/`background-image` は触らない)、
 * img / video / svg / canvas / picture は一切指定しない。
 */
const BLOCKS = "div, section, article, header, footer, nav, main, aside, ul, ol, li, table, tr, td, th, dl, dt, dd, p, span, h1, h2, h3, h4, h5, h6, form, fieldset";

/** ★ボタン/トーストの見た目(ID セレクタで上のブロック要素規則より優先させる)。 */
export function starCss(p: Palette): string {
  return [
    `#nb-star{background-color:${p.accent} !important;color:${p.onAccent} !important;border:2px solid ${p.bg} !important;}`,
    `#nb-toast{background-color:${p.accent} !important;color:${p.onAccent} !important;border:1px solid ${p.border} !important;}`,
    `#nb-toast[data-kind="error"]{background-color:${p.danger} !important;color:#ffffff !important;}`,
  ].join("\n");
}

/** loadstart 用: 背景色だけの最小 CSS(白フラッシュ軽減)。 */
export function minimalCss(p: Palette): string {
  return `html,body{background-color:${p.bg} !important;}`;
}

export function baseCss(p: Palette, dark: boolean): string {
  return [
    `html,body{background-color:${p.bg} !important;color:${p.fg} !important;}`,
    `${BLOCKS}{background-color:transparent !important;color:inherit !important;border-color:${p.border} !important;}`,
    `a{color:${p.link} !important;}`,
    `a:visited{color:${p.linkVisited} !important;}`,
    `input,select,textarea,button{background-color:${p.surface} !important;color:${p.fg} !important;border-color:${p.border} !important;}`,
    `::placeholder{color:${p.muted} !important;}`,
    `hr{border-color:${p.border} !important;}`,
    `::selection{background-color:${p.link};color:${p.bg};}`,
    `:root{color-scheme:${dark ? "dark" : "light"};}`,
  ].join("\n");
}
