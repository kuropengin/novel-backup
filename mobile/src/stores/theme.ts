import { ref } from "vue";
import { Preferences } from "@capacitor/preferences";
import { StatusBar, Style } from "@capacitor/status-bar";

export type Theme = "dark" | "light";
const KEY = "theme";
/** styles.css の --bg と同じ値(ステータスバー背景用) */
const BG: Record<Theme, string> = { dark: "#16181c", light: "#ffffff" };

export const theme = ref<Theme>("dark");

async function applyNative(t: Theme) {
  try {
    await StatusBar.setBackgroundColor({ color: BG[t] });
    // Style.Dark = 明るい文字(暗い背景向け)
    await StatusBar.setStyle({ style: t === "dark" ? Style.Dark : Style.Light });
  } catch {
    /* Web など未対応の環境では無視 */
  }
}

export function applyTheme(t: Theme) {
  theme.value = t;
  document.documentElement.dataset.theme = t;
  void applyNative(t);
}

export async function loadTheme() {
  let t: Theme = "dark";
  try {
    const v = (await Preferences.get({ key: KEY })).value;
    if (v === "light" || v === "dark") t = v;
  } catch {
    /* 既定のダーク */
  }
  applyTheme(t);
}

export async function toggleTheme() {
  const next: Theme = theme.value === "dark" ? "light" : "dark";
  applyTheme(next);
  try {
    await Preferences.set({ key: KEY, value: next });
  } catch {
    /* 保存失敗は無視 */
  }
}
