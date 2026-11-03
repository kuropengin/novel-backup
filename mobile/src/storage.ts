import { Preferences } from "@capacitor/preferences";
import { SecureStorage } from "@aparajita/capacitor-secure-storage";

export interface Settings {
  serverUrl: string;
  token: string;
  username: string;
  role: "" | "admin" | "viewer";
}

export const EMPTY_SETTINGS: Settings = { serverUrl: "", token: "", username: "", role: "" };

const KEYS = ["serverUrl", "token", "username", "role"] as const;

/** 認証トークンだけは Android Keystore で暗号化されるストアに保存し、他は Preferences に置く。 */
const SECURE_KEYS: ReadonlySet<string> = new Set(["token"]);

async function readValue(k: (typeof KEYS)[number]): Promise<string> {
  if (!SECURE_KEYS.has(k)) return (await Preferences.get({ key: k })).value ?? "";
  try {
    const v = await SecureStorage.get(k);
    if (typeof v === "string" && v) return v;
  } catch {
    /* 破損・未保存は旧保存分の移行確認へ */
  }
  // 旧バージョン(Preferences 平文)からの移行: 暗号化ストアへ移して平文を削除
  const legacy = (await Preferences.get({ key: k })).value ?? "";
  if (legacy) {
    try {
      await SecureStorage.set(k, legacy);
      await Preferences.remove({ key: k });
    } catch {
      /* 移行失敗時は次回起動で再試行 */
    }
  }
  return legacy;
}

export async function loadSettings(): Promise<Settings> {
  const out: Settings = { ...EMPTY_SETTINGS };
  for (const k of KEYS) {
    const v = await readValue(k);
    if (k === "role") out.role = v === "admin" || v === "viewer" ? v : "";
    else out[k] = v;
  }
  return out;
}

export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  for (const k of KEYS) {
    const v = patch[k];
    if (v === undefined) continue;
    if (SECURE_KEYS.has(k)) {
      if (v) await SecureStorage.set(k, v);
      else await SecureStorage.remove(k).catch(() => false);
      await Preferences.remove({ key: k }); // 旧平文の残りを確実に消す
    } else if (v) await Preferences.set({ key: k, value: v });
    else await Preferences.remove({ key: k });
  }
}

export { normalizeServerUrl } from "./logic/serverUrl";
