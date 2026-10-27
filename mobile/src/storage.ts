import { Preferences } from "@capacitor/preferences";

export interface Settings {
  serverUrl: string;
  token: string;
  username: string;
}

const KEYS = ["serverUrl", "token", "username"] as const;

export async function loadSettings(): Promise<Settings> {
  const out: Settings = { serverUrl: "", token: "", username: "" };
  for (const k of KEYS) out[k] = (await Preferences.get({ key: k })).value ?? "";
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
