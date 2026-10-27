import type { ThemeName } from "./palette";

/** 表示設定(端末ローカル)。fontSize は 1〜5 の段階。 */
export interface DisplaySettings {
  theme: ThemeName;
  fontSize: 1 | 2 | 3 | 4 | 5;
  lineHeight: number;
  font: "mincho" | "gothic";
  hideAds: boolean;
}

export const FONT_SIZES_PX = [15, 17, 19, 22, 26] as const;
export const LINE_HEIGHTS = [1.5, 1.7, 1.9, 2.2] as const;
export const FONT_STACKS = {
  mincho: '"Hiragino Mincho ProN","Yu Mincho","YuMincho","Noto Serif JP","Noto Serif CJK JP","MS PMincho",serif',
  gothic: 'system-ui,"Hiragino Sans","Noto Sans JP","Noto Sans CJK JP","Yu Gothic","Meiryo",sans-serif',
} as const;

export const DEFAULT_DISPLAY: DisplaySettings = { theme: "light", fontSize: 3, lineHeight: 1.9, font: "mincho", hideAds: true };

/** 保存値などの外部入力を安全な値へ丸める。 */
export function sanitizeDisplay(input: Partial<Record<keyof DisplaySettings, unknown>> | null | undefined): DisplaySettings {
  const d = DEFAULT_DISPLAY;
  const i = input ?? {};
  const theme = i.theme === "light" || i.theme === "sepia" || i.theme === "dark" ? i.theme : d.theme;
  const fs = Number(i.fontSize);
  const fontSize = (Number.isInteger(fs) && fs >= 1 && fs <= 5 ? fs : d.fontSize) as DisplaySettings["fontSize"];
  const lh = Number(i.lineHeight);
  const lineHeight = (LINE_HEIGHTS as readonly number[]).includes(lh) ? lh : d.lineHeight;
  const font = i.font === "gothic" || i.font === "mincho" ? i.font : d.font;
  const hideAds = typeof i.hideAds === "boolean" ? i.hideAds : d.hideAds;
  return { theme, fontSize, lineHeight, font, hideAds };
}
