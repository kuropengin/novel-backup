/** 広告ブロック(サイトビューア内のドメイン一致遮断)の純粋ロジック。 */
import type { BlocklistStatus } from "../native/siteView";
import { formatDateTime } from "./lists";

export interface ListLike {
  url: string;
  enabled: boolean;
}

/** 有効なリストの URL(重複なし・登録順)。https 以外は念のため除外する。 */
export function enabledUrls(lists: readonly ListLike[]): string[] {
  const out: string[] = [];
  for (const l of lists) {
    if (l.enabled && /^https:\/\//i.test(l.url) && !out.includes(l.url)) out.push(l.url);
  }
  return out;
}

/** Preferences に保存するキャッシュ(別ユーザーのリストを引き継がないよう、持ち主のユーザー名を添える) */
export interface UrlCache {
  user: string;
  urls: string[];
}

export function serializeCache(user: string, urls: readonly string[]): string {
  return JSON.stringify({ user, urls: [...urls] } satisfies UrlCache);
}

/** 保存値を読む。形式が不正、または持ち主が違えば null(=使わない)。 */
export function parseCache(raw: string | null | undefined, user: string): string[] | null {
  if (!raw || !user) return null;
  try {
    const v = JSON.parse(raw) as Partial<UrlCache>;
    if (!v || v.user !== user || !Array.isArray(v.urls)) return null;
    return v.urls.filter((u): u is string => typeof u === "string" && /^https:\/\//i.test(u));
  } catch {
    return null;
  }
}

export type StatusKind = "off" | "pending" | "ok" | "cached-error" | "error";

export interface StatusView {
  kind: StatusKind;
  /** 件数(取得できていなければ null) */
  domains: number | null;
  /** 最終更新の表示用(無ければ空文字) */
  updated: string;
  error: string;
}

/** 設定画面用に、リスト 1 件の状態を表示向けにまとめる。 */
export function statusView(enabled: boolean, st: BlocklistStatus | undefined): StatusView {
  if (!enabled) return { kind: "off", domains: st && st.updatedAt ? st.domains : null, updated: st?.updatedAt ? formatDateTime(new Date(st.updatedAt).toISOString()) : "", error: "" };
  if (!st) return { kind: "pending", domains: null, updated: "", error: "" };
  const updated = st.updatedAt ? formatDateTime(new Date(st.updatedAt).toISOString()) : "";
  if (st.error) return { kind: st.updatedAt ? "cached-error" : "error", domains: st.updatedAt ? st.domains : null, updated, error: st.error };
  return { kind: "ok", domains: st.domains, updated, error: "" };
}
