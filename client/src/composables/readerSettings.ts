import { reactive, watch } from "vue";

export type ReaderTheme = "light" | "sepia" | "dark";
export type ReaderFont = "mincho" | "gothic";

export interface ReaderSettings {
  fontSize: number; // px
  lineHeight: number;
  font: ReaderFont;
  theme: ReaderTheme;
  vertical: boolean;
}

const KEY = "nb.readerSettings";
const DEFAULTS: ReaderSettings = { fontSize: 18, lineHeight: 1.9, font: "mincho", theme: "light", vertical: false };

function load(): ReaderSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<ReaderSettings>;
      return {
        fontSize: clamp(Number(p.fontSize), 12, 36, DEFAULTS.fontSize),
        lineHeight: clamp(Number(p.lineHeight), 1.2, 3, DEFAULTS.lineHeight),
        font: p.font === "gothic" ? "gothic" : "mincho",
        theme: p.theme === "sepia" || p.theme === "dark" ? p.theme : "light",
        vertical: p.vertical === true,
      };
    }
  } catch {
    /* localStorage 不可 / 壊れた値は既定に */
  }
  return { ...DEFAULTS };
}

function clamp(n: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

let state: ReaderSettings | null = null;

/** 全リーダー画面で共有する表示設定(localStorage に保存)。 */
export function useReaderSettings(): ReaderSettings {
  if (!state) {
    state = reactive(load());
    watch(
      state,
      (v) => {
        try {
          localStorage.setItem(KEY, JSON.stringify(v));
        } catch {
          /* 保存できなくても動作は継続 */
        }
      },
      { deep: true },
    );
  }
  return state;
}
