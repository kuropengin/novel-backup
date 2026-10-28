import { Router } from "express";
import { z } from "zod";
import type { Db } from "../db/index.js";
import { nowIso } from "../db/index.js";
import { ah, parseBody, sendError } from "../http/errors.js";
import { isSiteId, novelUrl, resolveUrl, type SiteId } from "../sites.js";
import { requireAuth } from "../auth/session.js";

const KEY = /^[A-Za-z0-9_-]{1,64}$/;

// title は必須(アプリが表示中のページから取得して渡す)。author は任意。サーバーはサイトへアクセスしない
const meta = {
  title: z.string().trim().min(1).max(500),
  author: z.string().trim().max(200).optional(),
};
const createSchema = z.union([
  z.object({ site: z.string().refine(isSiteId, "unknown site"), novelKey: z.string().regex(KEY), ...meta }),
  z.object({ url: z.string().min(1).max(2048), ...meta }),
]);

const patchSchema = z
  .object({
    note: z.string().max(2000).optional(),
    title: z.string().trim().min(1).max(500).optional(),
    lastReadEpisodeKey: z.string().regex(KEY).nullable().optional(),
  })
  .strict();

const listQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  sort: z.enum(["added", "updated", "title", "site"]).default("added"),
  order: z.enum(["asc", "desc"]).default("desc"),
});

/** LIKE のワイルドカードをエスケープ(SQL 側は ESCAPE '!')。 */
export function escapeLike(s: string): string {
  return s.replace(/[!%_]/g, (c) => "!" + c);
}

/** サイトの日本語表示名でも検索できるようにする。 */
const SITE_LABEL_SQL = `(CASE n.site WHEN 'narou' THEN 'なろう 小説家になろう' WHEN 'kakuyomu' THEN 'カクヨム' WHEN 'hameln' THEN 'ハーメルン' ELSE '' END)`;

interface BookmarkRow {
  id: number;
  novel_id: number;
  note: string;
  last_read_episode_key: string | null;
  created_at: string;
  site: SiteId;
  novel_key: string;
  title: string;
  author: string;
  url: string;
}

const SELECT = `
  SELECT b.id, b.novel_id, b.note, b.last_read_episode_key, b.created_at,
         n.site, n.novel_key, n.title, n.author, n.url
  FROM bookmarks b JOIN novels n ON n.id = b.novel_id`;

export function toBookmarkDto(r: BookmarkRow) {
  return {
    id: r.id,
    novelId: r.novel_id,
    site: r.site,
    novelKey: r.novel_key,
    title: r.title,
    author: r.author,
    url: r.url,
    note: r.note,
    lastReadEpisodeKey: r.last_read_episode_key,
    createdAt: r.created_at,
  };
}

/** ユーザーのブックマーク ID(なければ null)。 */
export function findBookmarkId(db: Db, userId: number, site: SiteId, novelKey: string): number | null {
  const row = db
    .prepare(
      `SELECT b.id FROM bookmarks b JOIN novels n ON n.id = b.novel_id
       WHERE b.user_id = ? AND n.site = ? AND n.novel_key = ?`,
    )
    .get(userId, site, novelKey) as unknown as { id: number } | undefined;
  return row?.id ?? null;
}

export function bookmarksRouter(db: Db): Router {
  const router = Router();
  router.use(requireAuth);

  function getOne(userId: number, id: number): BookmarkRow | undefined {
    return db.prepare(`${SELECT} WHERE b.user_id = ? AND b.id = ?`).get(userId, id) as unknown as BookmarkRow | undefined;
  }
  function findNovelId(site: SiteId, novelKey: string): number | undefined {
    const row = db.prepare("SELECT id FROM novels WHERE site = ? AND novel_key = ?").get(site, novelKey) as unknown as
      | { id: number }
      | undefined;
    return row?.id;
  }

  function fillEmptyMeta(userId: number, bookmarkId: number, title: string, author?: string) {
    const b = getOne(userId, bookmarkId);
    if (!b) return;
    if (!b.title) db.prepare("UPDATE novels SET title = ? WHERE id = ?").run(title, b.novel_id);
    if (!b.author && author) db.prepare("UPDATE novels SET author = ? WHERE id = ?").run(author, b.novel_id);
  }

  // q: タイトル/作者/サイト(id・日本語名)の部分一致。sort: added|updated|title|site(updated は当面 added と同じ)
  router.get("/", (req, res) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) return void res.status(400).json({ error: "validation_error", details: parsed.error.issues });
    const { q, sort, order } = parsed.data;
    const dir = order === "asc" ? "ASC" : "DESC";
    const orderBy =
      sort === "title"
        ? `n.title COLLATE NOCASE ${dir}, b.id DESC`
        : sort === "site"
          ? `n.site ${dir}, b.created_at DESC, b.id DESC`
          : `b.created_at ${dir}, b.id ${dir}`;
    const params: (string | number)[] = [req.user!.id];
    let where = "WHERE b.user_id = ?";
    if (q) {
      const like = `%${escapeLike(q)}%`;
      where += ` AND (n.title LIKE ? ESCAPE '!' OR n.author LIKE ? ESCAPE '!' OR n.site LIKE ? ESCAPE '!' OR ${SITE_LABEL_SQL} LIKE ? ESCAPE '!')`;
      params.push(like, like, like, like);
    }
    const rows = db.prepare(`${SELECT} ${where} ORDER BY ${orderBy}`).all(...params) as unknown as BookmarkRow[];
    res.json({ bookmarks: rows.map(toBookmarkDto) });
  });

  // ★ 状態用。作品/話ページでない URL は bookmarked:false
  router.get("/lookup", (req, res) => {
    const url = typeof req.query.url === "string" ? req.query.url : "";
    if (!url) return sendError(res, 400, "validation_error", "url is required");
    const r = resolveUrl(url);
    const id = r ? findBookmarkId(db, req.user!.id, r.site, r.novelKey) : null;
    res.json({ bookmarked: id !== null, bookmarkId: id });
  });

  router.post(
    "/",
    ah(async (req, res) => {
      const body = parseBody(createSchema, req, res);
      if (!body) return;
      let site: SiteId;
      let novelKey: string;
      if ("url" in body) {
        const r = resolveUrl(body.url);
        if (!r) return sendError(res, 400, "not_a_novel_page", "作品ページ(または話ページ)の URL ではありません");
        site = r.site;
        novelKey = r.novelKey;
      } else {
        site = body.site as SiteId;
        novelKey = body.novelKey;
      }
      const userId = req.user!.id;

      const existing = findBookmarkId(db, userId, site, novelKey);
      if (existing !== null) {
        // 既存作品のタイトル/著者が空の場合のみ補完
        fillEmptyMeta(userId, existing, body.title, body.author);
        return void res.status(200).json({ bookmark: toBookmarkDto(getOne(userId, existing)!), created: false });
      }

      let novelId = findNovelId(site, novelKey);
      if (novelId === undefined) {
        db.prepare(
          `INSERT OR IGNORE INTO novels (site, novel_key, title, author, url, site_status, created_at)
           VALUES (?, ?, ?, ?, ?, 'unknown', ?)`,
        ).run(site, novelKey, body.title, body.author ?? "", novelUrl(site, novelKey), nowIso());
        novelId = findNovelId(site, novelKey)!;
      }
      db.prepare("INSERT OR IGNORE INTO bookmarks (user_id, novel_id, created_at) VALUES (?, ?, ?)").run(userId, novelId, nowIso());
      const id = findBookmarkId(db, userId, site, novelKey)!;
      res.status(201).json({ bookmark: toBookmarkDto(getOne(userId, id)!), created: true });
    }),
  );

  router.patch("/:id", (req, res) => {
    const id = Number(req.params.id);
    const body = parseBody(patchSchema, req, res);
    if (!body) return;
    const userId = req.user!.id;
    if (!Number.isInteger(id) || !getOne(userId, id)) return sendError(res, 404, "not_found");
    if (body.note !== undefined) db.prepare("UPDATE bookmarks SET note = ? WHERE id = ? AND user_id = ?").run(body.note, id, userId);
    if (body.title !== undefined) {
      db.prepare("UPDATE novels SET title = ? WHERE id = (SELECT novel_id FROM bookmarks WHERE id = ? AND user_id = ?)").run(body.title, id, userId);
    }
    if (body.lastReadEpisodeKey !== undefined) {
      db.prepare("UPDATE bookmarks SET last_read_episode_key = ? WHERE id = ? AND user_id = ?").run(body.lastReadEpisodeKey, id, userId);
    }
    res.json({ bookmark: toBookmarkDto(getOne(userId, id)!) });
  });

  router.delete("/:id", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return sendError(res, 404, "not_found");
    const r = db.prepare("DELETE FROM bookmarks WHERE id = ? AND user_id = ?").run(id, req.user!.id);
    if (r.changes === 0) return sendError(res, 404, "not_found");
    res.json({ ok: true });
  });

  return router;
}
