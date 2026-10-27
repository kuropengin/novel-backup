import { api } from "./client";
import type { Bookmark, LiveEpisode, NovelInfo, ResolvedUrl, SiteId, SiteInfo } from "./types";

export const liveApi = {
  sites: () => api<{ sites: SiteInfo[] }>("/api/live/sites"),
  resolve: (url: string) => api<ResolvedUrl>(`/api/live/resolve?url=${encodeURIComponent(url)}`),
  novel: (site: SiteId, novelKey: string) =>
    api<NovelInfo>(`/api/live/${site}/novels/${encodeURIComponent(novelKey)}`),
  episode: (site: SiteId, novelKey: string, episodeKey: string) =>
    api<LiveEpisode>(
      `/api/live/${site}/novels/${encodeURIComponent(novelKey)}/episodes/${encodeURIComponent(episodeKey)}`,
    ),
};

export const bookmarksApi = {
  list: () => api<{ bookmarks: Bookmark[] }>("/api/bookmarks"),
  create: (site: SiteId, novelKey: string) =>
    api<{ bookmark: Bookmark; created: boolean }>("/api/bookmarks", { method: "POST", body: { site, novelKey } }),
  update: (id: number, patch: { note?: string; title?: string; lastReadEpisodeKey?: string | null }) =>
    api<{ bookmark: Bookmark }>(`/api/bookmarks/${id}`, { method: "PATCH", body: patch }),
  remove: (id: number) => api<{ ok: true }>(`/api/bookmarks/${id}`, { method: "DELETE" }),
};
