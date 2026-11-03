import { Router } from "express";
import { z } from "zod";
import type { Db } from "../db/index.js";
import { nowIso } from "../db/index.js";
import { ah, parseBody, sendError } from "../http/errors.js";
import { isSiteId } from "../sites.js";
import { requireAuth } from "../auth/session.js";

const KEY = /^[A-Za-z0-9_-]{1,64}$/;
const putSchema = z.object({ read: z.boolean() }).strict();

/** 話単位の既読管理(ユーザー別)。episodeKey は /api/backup/novels/:site/:novelKey/episodes のもの。 */
export function readingProgressRouter(db: Db): Router {
  const router = Router();
  router.use(requireAuth);

  router.get("/:site/:novelKey", (req, res) => {
    const site = String(req.params.site), novelKey = String(req.params.novelKey);
    if (!isSiteId(site) || !KEY.test(novelKey)) return sendError(res, 400, "validation_error", "invalid site or novelKey");
    const rows = db
      .prepare(
        `SELECT episode_key, read_at FROM reading_progress
         WHERE user_id = ? AND site = ? AND novel_key = ?
         ORDER BY read_at DESC, episode_key DESC`,
      )
      .all(req.user!.id, site, novelKey) as unknown as Array<{ episode_key: string; read_at: string }>;
    res.json({
      readEpisodeKeys: rows.map((r) => r.episode_key),
      lastReadEpisodeKey: rows[0]?.episode_key ?? null,
      lastReadAt: rows[0]?.read_at ?? null,
    });
  });

  router.put(
    "/:site/:novelKey/:episodeKey",
    ah(async (req, res) => {
      const site = String(req.params.site), novelKey = String(req.params.novelKey), episodeKey = String(req.params.episodeKey);
      if (!isSiteId(site) || !KEY.test(novelKey) || !KEY.test(episodeKey)) {
        return sendError(res, 400, "validation_error", "invalid site, novelKey or episodeKey");
      }
      const body = parseBody(putSchema, req, res);
      if (!body) return;
      const userId = req.user!.id;
      if (body.read) {
        db.prepare(
          `INSERT INTO reading_progress (user_id, site, novel_key, episode_key, read_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(user_id, site, novel_key, episode_key) DO UPDATE SET read_at = excluded.read_at`,
        ).run(userId, site, novelKey, episodeKey, nowIso());
      } else {
        db.prepare("DELETE FROM reading_progress WHERE user_id = ? AND site = ? AND novel_key = ? AND episode_key = ?").run(
          userId,
          site,
          novelKey,
          episodeKey,
        );
      }
      res.json({ ok: true });
    }),
  );

  return router;
}
