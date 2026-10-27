import { Preferences } from "@capacitor/preferences";
import { DEFAULT_DISPLAY, sanitizeDisplay, type DisplaySettings } from "./settings";

const KEY = "display";

export async function loadDisplay(): Promise<DisplaySettings> {
  try {
    const v = (await Preferences.get({ key: KEY })).value;
    return v ? sanitizeDisplay(JSON.parse(v)) : { ...DEFAULT_DISPLAY };
  } catch {
    return { ...DEFAULT_DISPLAY };
  }
}

export async function saveDisplay(d: DisplaySettings): Promise<void> {
  await Preferences.set({ key: KEY, value: JSON.stringify(d) });
}
