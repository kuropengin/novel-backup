import { Router } from "express";
import type { Db } from "../db/index.js";
import { requireAuth } from "../auth/session.js";
import { ah, sendError } from "../http/errors.js";
import { sendSiteError } from "../http/siteErrors.js";
import type { LiveService } from "../live/service.js";
import { isSiteId, listAdapters, resolveUrl } from "../sites/index.js";
import { findBookmarkId } from "./bookmarks.js";

const KEY = /^[A-Za-z0-9_-]{1,64}$/;

export function liveRouter(db: Db, live: LiveService): Router {
  const router = Router();
  router.use(requireAuth);

  /** ブラウズ画面用: サイト一覧と Proxy 許可ホスト */
  router.get("/sites", (_req, res) => {
    res.json({
      sites: listAdapters().map((a) => ({ site: a.site, displayName: a.displayName, hosts: a.hosts, defaultHost: a.hosts[0] })),
    });
  });

  router.get("/resolve", (req, res) => {
    const url = req.query.url;
    if (typeof url !== "string" || !url || url.length > 2048) return sendError(res, 400, "validation_error");
    const r = resolveUrl(url);
    if (!r) return sendError(res, 404, "not_found", "作品ページ/話ページではありません");
    const bookmarkId = findBookmarkId(db, req.user!.id, r.site, r.novelKey);
    res.json({ ...r, bookmarked: bookmarkId !== null, bookmarkId });
  });

  router.get(
    "/:site/novels/:novelKey",
    ah(async (req, res) => {
      const { site, novelKey } = req.params as { site: string; novelKey: string };
      if (!isSiteId(site) || !KEY.test(novelKey)) return sendError(res, 404, "not_found");
      try {
        const info = await live.getNovel(site, novelKey);
        const bookmarkId = findBookmarkId(db, req.user!.id, site, novelKey);
        res.json({ ...info, bookmarked: bookmarkId !== null, bookmarkId });
      } catch (e) {
        sendSiteError(res, e);
      }
    }),
  );

  router.get(
    "/:site/novels/:novelKey/episodes/:episodeKey",
    ah(async (req, res) => {
      const { site, novelKey, episodeKey } = req.params as { site: string; novelKey: string; episodeKey: string };
      if (!isSiteId(site) || !KEY.test(novelKey) || !KEY.test(episodeKey)) return sendError(res, 404, "not_found");
      try {
        const info = await live.getNovel(site, novelKey);
        const ep = await live.getEpisode(site, novelKey, episodeKey);
        const idx = info.episodes.findIndex((e) => e.episodeKey === episodeKey);
        const prev = idx > 0 ? info.episodes[idx - 1] : undefined;
        const next = idx >= 0 ? info.episodes[idx + 1] : undefined;
        const bookmarkId = findBookmarkId(db, req.user!.id, site, novelKey);
        res.json({
          ...ep,
          site,
          novelKey,
          novelTitle: info.title,
          chapter: idx >= 0 ? (info.episodes[idx]!.chapter ?? null) : null,
          index: idx,
          total: info.episodes.length,
          url: live.getAdapter(site).episodeUrl(novelKey, episodeKey),
          prevEpisodeKey: prev?.episodeKey ?? null,
          nextEpisodeKey: next?.episodeKey ?? null,
          bookmarked: bookmarkId !== null,
          bookmarkId,
        });
      } catch (e) {
        sendSiteError(res, e);
      }
    }),
  );

  return router;
}
