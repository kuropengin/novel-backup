import { Router } from "express";
import { z } from "zod";
import type { Db } from "../db/index.js";
import { nowIso } from "../db/index.js";
import { parseBody, sendError } from "../http/errors.js";
import { isSiteId, resolveUrl, type SiteId } from "../sites.js";
import { requireAuth } from "../auth/session.js";
import { escapeLike } from "./bookmarks.js";

const KEY = /^[A-Za-z0-9_-]{1,64}$/;

const postSchema = z.object({
  url: z.string().min(1).max(2048),
  novelTitle: z.string().trim().max(500).optional(),
  episodeTitle: z.string().trim().max(500).optional(),
  // オフライン中に溜めた閲覧の送信用。未来の時刻は現在時刻に丸める
  viewedAt: z.iso.datetime({ offset: true }).optional(),
});

const listSchema = z.object({
  view: z.enum(["episode", "novel"]).default("episode"),
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

const deleteSchema = z.object({
  site: z.string().refine(isSiteId, "unknown site").optional(),
  novelKey: z.string().regex(KEY).optional(),
});

interface HistoryRow {
  id: number;
  site: SiteId;
  novel_key: string;
  episode_key: string;
  novel_title: string;
  episode_title: string;
  url: string;
  viewed_at: string;
}
interface NovelRow extends HistoryRow {
  episode_count: number;
  last_viewed_at: string;
}

const toEpisodeDto = (r: HistoryRow) => ({
  id: r.id,
  site: r.site,
  novelKey: r.novel_key,
  episodeKey: r.episode_key,
  novelTitle: r.novel_title,
  episodeTitle: r.episode_title,
  url: r.url,
  viewedAt: r.viewed_at,
});

/** 作品毎: id/episodeKey/episodeTitle/url は「最後に読んだ話」(話の閲覧が無ければ作品ページ行)のもの。 */
const toNovelDto = (r: NovelRow) => ({
  id: r.id,
  site: r.site,
  novelKey: r.novel_key,
  novelTitle: r.novel_title,
  episodeKey: r.episode_key,
  episodeTitle: r.episode_title,
  url: r.url,
  episodeCount: r.episode_count,
  viewedAt: r.last_viewed_at,
});

export function historyRouter(db: Db): Router {
  const router = Router();
  router.use(requireAuth);

  router.post("/", (req, res) => {
    const body = parseBody(postSchema, req, res);
    if (!body) return;
    const r = resolveUrl(body.url);
    if (!r) return sendError(res, 400, "not_a_novel_page", "作品ページ(または話ページ)の URL ではありません");
    const now = nowIso();
    let viewedAt = body.viewedAt ? new Date(body.viewedAt).toISOString() : now;
    if (viewedAt > now) viewedAt = now;
    const episodeKey = r.episodeKey ?? "";
    // 同じページの再閲覧は viewed_at/url を更新。タイトルは空でない値のときだけ上書き。
    // 古い時刻(オフライン送信)で新しい viewed_at を巻き戻さない
    db.prepare(
      `INSERT INTO history (user_id, site, novel_key, episode_key, novel_title, episode_title, url, viewed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, site, novel_key, episode_key) DO UPDATE SET
         novel_title   = CASE WHEN excluded.novel_title <> '' THEN excluded.novel_title ELSE history.novel_title END,
         episode_title = CASE WHEN excluded.episode_title <> '' THEN excluded.episode_title ELSE history.episode_title END,
         url           = CASE WHEN excluded.viewed_at >= history.viewed_at THEN excluded.url ELSE history.url END,
         viewed_at     = MAX(excluded.viewed_at, history.viewed_at)`,
    ).run(req.user!.id, r.site, r.novelKey, episodeKey, body.novelTitle ?? "", episodeKey ? (body.episodeTitle ?? "") : "", body.url, viewedAt);
    const row = db
      .prepare("SELECT * FROM history WHERE user_id = ? AND site = ? AND novel_key = ? AND episode_key = ?")
      .get(req.user!.id, r.site, r.novelKey, episodeKey) as unknown as HistoryRow;
    res.status(200).json({ history: toEpisodeDto(row) });
  });

  router.get("/", (req, res) => {
    const parsed = listSchema.safeParse(req.query);
    if (!parsed.success) return void res.status(400).json({ error: "validation_error", details: parsed.error.issues });
    const { view, q, limit, offset } = parsed.data;
    const userId = req.user!.id;
    const like = q ? `%${escapeLike(q)}%` : null;

    if (view === "episode") {
      const where = like ? "AND (novel_title LIKE ? ESCAPE '!' OR episode_title LIKE ? ESCAPE '!')" : "";
      const params = like ? [userId, like, like, limit, offset] : [userId, limit, offset];
      const rows = db
        .prepare(`SELECT * FROM history WHERE user_id = ? ${where} ORDER BY viewed_at DESC, id DESC LIMIT ? OFFSET ?`)
        .all(...params) as unknown as HistoryRow[];
      return void res.json({ view, history: rows.map(toEpisodeDto) });
    }

    // 作品毎: (site, novel_key) で集約。代表行は話の閲覧(episode_key <> '')を優先し、その中で最新。
    // 絞り込みは作品内のどれかの行が一致すれば作品ごと残す(話数・最終閲覧は絞り込み前の値)
    const match = like ? "(novel_title LIKE ? ESCAPE '!' OR episode_title LIKE ? ESCAPE '!')" : "1";
    const sql = `
      WITH g AS (
        SELECT h.*,
          ROW_NUMBER() OVER (PARTITION BY site, novel_key ORDER BY (episode_key <> '') DESC, viewed_at DESC, id DESC) AS rn,
          COUNT(CASE WHEN episode_key <> '' THEN 1 END) OVER (PARTITION BY site, novel_key) AS episode_count,
          MAX(viewed_at) OVER (PARTITION BY site, novel_key) AS last_viewed_at,
          MAX(novel_title) OVER (PARTITION BY site, novel_key) AS any_title,
          MAX(${match}) OVER (PARTITION BY site, novel_key) AS matched
        FROM history h WHERE user_id = ?
      )
      SELECT id, site, novel_key, episode_key,
             CASE WHEN novel_title <> '' THEN novel_title ELSE any_title END AS novel_title,
             episode_title, url, episode_count, last_viewed_at, viewed_at
      FROM g WHERE rn = 1 AND matched = 1
      ORDER BY last_viewed_at DESC, id DESC LIMIT ? OFFSET ?`;
    // プレースホルダの順序: match(2) → userId → limit → offset
    const params = like ? [like, like, userId, limit, offset] : [userId, limit, offset];
    const rows = db.prepare(sql).all(...params) as unknown as NovelRow[];
    res.json({ view, history: rows.map(toNovelDto) });
  });

  // 作品単位の削除(?site=&novelKey=)または全消去(クエリ無し)
  router.delete("/", (req, res) => {
    const parsed = deleteSchema.safeParse(req.query);
    if (!parsed.success) return void res.status(400).json({ error: "validation_error", details: parsed.error.issues });
    const { site, novelKey } = parsed.data;
    if ((site === undefined) !== (novelKey === undefined)) {
      return sendError(res, 400, "validation_error", "site と novelKey は両方指定してください");
    }
    const userId = req.user!.id;
    const r =
      site !== undefined
        ? db.prepare("DELETE FROM history WHERE user_id = ? AND site = ? AND novel_key = ?").run(userId, site, novelKey!)
        : db.prepare("DELETE FROM history WHERE user_id = ?").run(userId);
    res.json({ ok: true, deleted: Number(r.changes) });
  });

  router.delete("/:id", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return sendError(res, 404, "not_found");
    const r = db.prepare("DELETE FROM history WHERE id = ? AND user_id = ?").run(id, req.user!.id);
    if (r.changes === 0) return sendError(res, 404, "not_found");
    res.json({ ok: true });
  });

  return router;
}
