/** 一覧画面用の純粋関数(絞り込み・並べ替え・日時表示)。 */
import { siteLabel } from "./sites";

export interface BookmarkLike {
  id: number;
  site: string;
  title: string;
  author: string;
  createdAt: string;
  updatedAt?: string;
  /** 元サイトでの最終更新日時(更新日ソートの第一キー) */
  sourceUpdatedAt?: string | null;
  /** オフライン保存済みか */
  offlineSaved?: boolean;
}

export type SortKey = "added" | "updated" | "title" | "site";
export type SortOrder = "asc" | "desc";

export const SORT_OPTIONS: { key: SortKey; label: string; note?: string }[] = [
  { key: "added", label: "追加日" },
  { key: "updated", label: "更新日" },
  { key: "title", label: "タイトル" },
  { key: "site", label: "サイト" },
];

/** タイトル・作者・サイト(id と日本語名)の部分一致。空白区切りは AND。大小無視。 */
export function filterBookmarks<T extends BookmarkLike>(items: readonly T[], q: string): T[] {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [...items];
  return items.filter((b) => {
    const hay = `${b.title}\n${b.author}\n${b.site}\n${siteLabel(b.site)}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}

export function sortBookmarks<T extends BookmarkLike>(items: readonly T[], key: SortKey, order: SortOrder): T[] {
  const dir = order === "asc" ? 1 : -1;
  const added = (a: T, b: T) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id;
  // 元サイトの更新日を優先(null は最も古い扱い=降順で末尾)。同値・null 同士はバックアップ日→追加日の順
  const updated = (a: T, b: T) =>
    (a.sourceUpdatedAt ?? "").localeCompare(b.sourceUpdatedAt ?? "") ||
    (a.updatedAt ?? a.createdAt).localeCompare(b.updatedAt ?? b.createdAt) ||
    added(a, b);
  const cmp = (a: T, b: T): number => {
    switch (key) {
      case "title":
        return a.title.localeCompare(b.title, "ja") || added(a, b);
      case "site":
        return a.site.localeCompare(b.site) || added(a, b);
      case "updated":
        return updated(a, b);
      default:
        return added(a, b);
    }
  };
  return [...items].sort((a, b) => dir * cmp(a, b));
}

/** オフライン時は端末に保存済みの作品だけを表示する。 */
export function offlineOnly<T extends BookmarkLike>(items: readonly T[]): T[] {
  return items.filter((b) => b.offlineSaved === true);
}

/** ISO 日時 → 相対表示。不正な値は空文字。 */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.floor((now - t) / 1000);
  if (s < 60) return "たった今";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}分前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}時間前`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}日前`;
  return formatDate(iso);
}

/** ISO 日時 → "2026/10/28"(端末のタイムゾーン)。不正な値は空文字。 */
export function formatDate(iso: string): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return "";
  return `${t.getFullYear()}/${t.getMonth() + 1}/${t.getDate()}`;
}

/** ユーザー名の頭文字(アバター用)。空なら "?"。 */
export function initialOf(name: string): string {
  const ch = Array.from(name.trim())[0];
  return ch ? ch.toUpperCase() : "?";
}
