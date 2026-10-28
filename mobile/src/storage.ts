import { Preferences } from "@capacitor/preferences";

export interface Settings {
  serverUrl: string;
  token: string;
  username: string;
  role: "" | "admin" | "viewer";
}

export const EMPTY_SETTINGS: Settings = { serverUrl: "", token: "", username: "", role: "" };

const KEYS = ["serverUrl", "token", "username", "role"] as const;

export async function loadSettings(): Promise<Settings> {
  const out: Settings = { ...EMPTY_SETTINGS };
  for (const k of KEYS) {
    const v = (await Preferences.get({ key: k })).value ?? "";
    if (k === "role") out.role = v === "admin" || v === "viewer" ? v : "";
    else out[k] = v;
  }
  return out;
}

export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  for (const k of KEYS) {
    const v = patch[k];
    if (v === undefined) continue;
    if (v) await Preferences.set({ key: k, value: v });
    else await Preferences.remove({ key: k });
  }
}

/** "192.168.1.10:3000" → "http://192.168.1.10:3000"。末尾スラッシュは除去。 */
export function normalizeServerUrl(input: string): string {
  let s = input.trim();
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  return s.replace(/\/+$/, "");
}
