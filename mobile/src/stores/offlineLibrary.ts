import { Preferences } from "@capacitor/preferences";
import type { BackupEpisode } from "../api";

const KEY = "offline_library_v1";

export interface OfflineNovel {
  key: string;
  site: string;
  novelKey: string;
  title: string;
  author: string;
  savedAt: string;
  episodes: BackupEpisode[];
}

interface OfflineLibrary {
  novels: Record<string, OfflineNovel>;
}

let cache: OfflineLibrary | null = null;

function emptyLibrary(): OfflineLibrary {
  return { novels: {} };
}

async function loadLibrary(): Promise<OfflineLibrary> {
  if (cache) return cache;
  try {
    const raw = (await Preferences.get({ key: KEY })).value;
    if (!raw) {
      cache = emptyLibrary();
      return cache;
    }
    const parsed = JSON.parse(raw) as OfflineLibrary;
    cache = parsed && typeof parsed === "object" && parsed.novels ? parsed : emptyLibrary();
  } catch {
    cache = emptyLibrary();
  }
  return cache;
}

async function persist(lib: OfflineLibrary): Promise<void> {
  cache = lib;
  await Preferences.set({ key: KEY, value: JSON.stringify(lib) });
}

export function offlineNovelKey(site: string, novelKey: string): string {
  return `${site}:${novelKey}`;
}

export async function listOfflineNovelKeys(): Promise<Set<string>> {
  const lib = await loadLibrary();
  return new Set(Object.keys(lib.novels));
}

export async function saveOfflineNovel(input: Omit<OfflineNovel, "key" | "savedAt">): Promise<void> {
  const lib = await loadLibrary();
  const key = offlineNovelKey(input.site, input.novelKey);
  lib.novels[key] = { ...input, key, savedAt: new Date().toISOString() };
  await persist(lib);
}

export async function getOfflineNovel(site: string, novelKey: string): Promise<OfflineNovel | null> {
  const lib = await loadLibrary();
  return lib.novels[offlineNovelKey(site, novelKey)] ?? null;
}
