/** テーマ毎の色トークン。配色は Web 版リーダー(client/src/components/EpisodeReader.vue の --r-bg/--r-fg/--r-line)と揃える。 */
export type ThemeName = "light" | "sepia" | "dark";

export interface Palette {
  bg: string;
  surface: string;
  fg: string;
  muted: string;
  link: string;
  linkVisited: string;
  border: string;
  accent: string;
  /** accent の上に載せる文字色(★ボタン・トースト) */
  onAccent: string;
  danger: string;
}

export const THEMES: readonly ThemeName[] = ["light", "sepia", "dark"];

export const THEME_LABELS: Record<ThemeName, string> = { light: "ライト", sepia: "セピア", dark: "ダーク" };

export const PALETTES: Record<ThemeName, Palette> = {
  light: {
    bg: "#ffffff",
    surface: "#f3f5f6",
    fg: "#232629",
    muted: "#6b7378",
    link: "#1a5fb4",
    linkVisited: "#7a4aa0",
    border: "#dde1e4",
    accent: "#2b6b47",
    onAccent: "#ffffff",
    danger: "#b3261e",
  },
  sepia: {
    bg: "#f4ecd8",
    surface: "#eadfc4",
    fg: "#433422",
    muted: "#7a6a52",
    link: "#8a4b08",
    linkVisited: "#6e4a73",
    border: "#d9ccaa",
    accent: "#7a5a1e",
    onAccent: "#fff8e6",
    danger: "#a3321f",
  },
  dark: {
    bg: "#16181a",
    surface: "#202427",
    fg: "#cfd3d6",
    muted: "#8d969b",
    link: "#7fb4f0",
    linkVisited: "#b79ae0",
    border: "#33393d",
    accent: "#5fb583",
    onAccent: "#0f1a14",
    danger: "#f2877f",
  },
};
