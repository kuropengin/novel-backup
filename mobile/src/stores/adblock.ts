import { ref } from "vue";
import { Preferences } from "@capacitor/preferences";
import {
  addBlocklist,
  deleteBlocklist,
  listBlocklists,
  setBlocklistEnabled,
  type ApiConfig,
  type Blocklist,
} from "../api";
import { enabledUrls, parseCache, serializeCache } from "../logic/adblock";
import { SiteView, type BlocklistStatus } from "../native/siteView";

/**
 * 広告ブロック。サーバーからユーザーのリスト設定を取り、有効な URL をネイティブ(SiteView)へ渡す。
 * ダウンロード/解析はネイティブがバックグラウンドで行う。端末の DNS は変更しない。
 */
const CACHE_KEY = "adblockUrls";

export const blocklists = ref<Blocklist[]>([]);
export const blocklistStatus = ref<Record<string, BlocklistStatus>>({});
export const blocklistLoading = ref(false);

/** 古い非同期結果で新しい状態を上書きしないための世代番号 */
let gen = 0;

async function applyNative(urls: string[]) {
  try {
    await SiteView.setBlocklists({ urls });
  } catch {
    /* ネイティブ側の失敗は広告ブロックが効かないだけ(fail-open) */
  }
}

export async function refreshBlocklistStatus(): Promise<void> {
  try {
    const r = await SiteView.getBlocklistStatus();
    blocklistStatus.value = Object.fromEntries(r.lists.map((s) => [s.url, s]));
    blocklistLoading.value = r.loading;
  } catch {
    /* 取得できなければ表示を更新しないだけ */
  }
}

/** ログイン後・起動時: リストを取得して適用する。ネットワーク不達なら、同じユーザーのキャッシュ済み URL を使う。 */
export async function startAdblock(cfg: ApiConfig, username: string): Promise<void> {
  const my = ++gen;
  let urls: string[] | null = null;
  try {
    const lists = await listBlocklists(cfg);
    if (my !== gen) return;
    blocklists.value = lists;
    urls = enabledUrls(lists);
    try {
      await Preferences.set({ key: CACHE_KEY, value: serializeCache(username, urls) });
    } catch {
      /* 保存失敗は無視 */
    }
  } catch {
    if (my !== gen) return;
    // 到達不能・サーバーエラーは同じユーザーのキャッシュで動かす(認証切れはログアウト処理が clearAdblock を呼ぶ)
    try {
      urls = parseCache((await Preferences.get({ key: CACHE_KEY })).value, username);
    } catch {
      urls = null;
    }
    if (my !== gen) return;
  }
  if (urls) await applyNative(urls);
  void refreshBlocklistStatus();
}

/** ログアウト/ユーザー切替: マッチャを破棄しキャッシュ URL を消す(別ユーザーへ持ち越さない)。 */
export async function clearAdblock(): Promise<void> {
  ++gen;
  blocklists.value = [];
  blocklistStatus.value = {};
  blocklistLoading.value = false;
  try {
    await Preferences.remove({ key: CACHE_KEY });
  } catch {
    /* 無視 */
  }
  await applyNative([]);
}

/** 変更後にサーバーの最新を取り直して適用し直す。 */
async function reapply(cfg: ApiConfig, username: string) {
  await startAdblock(cfg, username);
}

export async function toggleBlocklist(cfg: ApiConfig, username: string, id: number, enabled: boolean): Promise<void> {
  await setBlocklistEnabled(cfg, id, enabled);
  await reapply(cfg, username);
}

export async function createBlocklist(cfg: ApiConfig, username: string, name: string, url: string): Promise<void> {
  await addBlocklist(cfg, { name, url });
  await reapply(cfg, username);
}

export async function removeBlocklist(cfg: ApiConfig, username: string, id: number): Promise<void> {
  await deleteBlocklist(cfg, id);
  await reapply(cfg, username);
}
