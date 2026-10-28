/**
 * エピソード本文の表示設定(文字サイズ・行間・明朝/ゴシック)。
 * 配色や広告には一切触れない。各サイトの本文コンテナだけに CSS を適用する。
 */
export interface DisplaySettings {
  fontSize: 1 | 2 | 3 | 4 | 5;
  lineHeight: number;
  font: "mincho" | "gothic";
}

export const FONT_SIZES_PX = [15, 17, 19, 22, 26] as const;
export const LINE_HEIGHTS = [1.5, 1.7, 1.9, 2.2] as const;
export const FONT_STACKS = {
  mincho: '"Hiragino Mincho ProN","Yu Mincho","YuMincho","Noto Serif JP","Noto Serif CJK JP","MS PMincho",serif',
  gothic: 'system-ui,"Hiragino Sans","Noto Sans JP","Noto Sans CJK JP","Yu Gothic","Meiryo",sans-serif',
} as const;

export const DEFAULT_DISPLAY: DisplaySettings = { fontSize: 3, lineHeight: 1.9, font: "mincho" };

/** 保存値などの外部入力を安全な値へ丸める(旧バージョンの theme / hideAds 等は無視)。 */
export function sanitizeDisplay(input: Partial<Record<string, unknown>> | null | undefined): DisplaySettings {
  const d = DEFAULT_DISPLAY;
  const i = input ?? {};
  const fs = Number(i.fontSize);
  const fontSize = (Number.isInteger(fs) && fs >= 1 && fs <= 5 ? fs : d.fontSize) as DisplaySettings["fontSize"];
  const lh = Number(i.lineHeight);
  const lineHeight = (LINE_HEIGHTS as readonly number[]).includes(lh) ? lh : d.lineHeight;
  const font = i.font === "gothic" || i.font === "mincho" ? i.font : d.font;
  return { fontSize, lineHeight, font };
}

export interface SiteBody {
  id: "narou" | "kakuyomu" | "hameln";
  /** ホスト名(hostname)が対象か */
  hostPattern: RegExp;
  /** 話ページの本文コンテナ */
  bodySelectors: readonly string[];
}

export const SITES: readonly SiteBody[] = [
  // なろう(新旧レイアウト。前書き/後書きは旧 #novel_p / #novel_a)
  { id: "narou", hostPattern: /(^|\.)syosetu\.com$/, bodySelectors: [".p-novel__text", "#novel_honbun", "#novel_p", "#novel_a"] },
  { id: "kakuyomu", hostPattern: /(^|\.)kakuyomu\.jp$/, bodySelectors: [".widget-episodeBody"] },
  // ハーメルン(実 DOM 未検証。本文・前書き・後書き)
  { id: "hameln", hostPattern: /(^|\.)syosetu\.org$/, bodySelectors: ["#honbun", "#maegaki", "#atogaki"] },
];

/** ホスト名から対象サイトを判定。3 サイト以外は null(CSS を注入しない)。 */
export function siteOfHost(hostname: string): SiteBody | null {
  const h = hostname.toLowerCase();
  return SITES.find((s) => s.hostPattern.test(h)) ?? null;
}

/**
 * 本文コンテナだけに文字サイズ・行間・フォントを当てる CSS。対象外ホストは空文字。
 * ルビ(rt)は本文サイズに追従させる。色・背景・広告には触れない。
 */
export function buildCss(hostname: string, d: DisplaySettings): string {
  const site = siteOfHost(hostname);
  if (!site) return "";
  const px = FONT_SIZES_PX[d.fontSize - 1];
  const sel = site.bodySelectors.flatMap((c) => [c, `${c} p`]).join(",");
  const rt = site.bodySelectors.map((c) => `${c} rt`).join(",");
  return [
    `${sel}{font-size:${px}px !important;line-height:${d.lineHeight} !important;font-family:${FONT_STACKS[d.font]} !important;}`,
    `${rt}{font-size:0.5em !important;line-height:1 !important;}`,
  ].join("\n");
}
