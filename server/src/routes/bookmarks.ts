import { Router } from "express";
import { z } from "zod";
import type { Db } from "../db/index.js";
import { nowIso } from "../db/index.js";
import { enqueueNovelBackup } from "../backup/queue.js";
import { ah, parseBody, sendError } from "../http/errors.js";
import { sendSiteError } from "../http/siteErrors.js";
import type { LiveService } from "../live/service.js";
import { isSiteId, resolveUrl, SiteNotFoundError, type SiteId } from "../sites/index.js";
import { requireAuth } from "../auth/session.js";

const KEY = /^[A-Za-z0-9_-]{1,64}$/;

// title / author は任意。title 指定時はサイトへ取得せずその値で作品を作成する(モバイルアプリ用)
const optionalMeta = {
  title: z.string().trim().min(1).max(500).optional(),
  author: z.string().trim().max(200).optional(),
};
const createSchema = z.union([
  z.object({ site: z.string().refine(isSiteId, "unknown site"), novelKey: z.string().regex(KEY), ...optionalMeta }),
  z.object({ url: z.string().min(1).max(2048), ...optionalMeta }),
]);

const patchSchema = z
  .object({
    note: z.string().max(2000).optional(),
    title: z.string().trim().min(1).max(500).optional(),
    lastReadEpisodeKey: z.string().regex(KEY).nullable().optional(),
  })
  .strict();

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
  site_status: string;
  is_deleted_on_site: number;
  last_checked_at: string | null;
  last_changed_at: string | null;
  last_error: string | null;
  episode_count: number;
  unread_count: number;
}

const SELECT = `
  SELECT b.id, b.novel_id, b.note, b.last_read_episode_key, b.created_at,
         n.site, n.novel_key, n.title, n.author, n.url, n.site_status, n.is_deleted_on_site,
         n.last_checked_at, n.last_changed_at, n.last_error,
         (SELECT COUNT(*) FROM episodes e WHERE e.novel_id = n.id AND e.removed_at IS NULL) AS episode_count,
         (SELECT COUNT(*) FROM episodes e WHERE e.novel_id = n.id AND e.removed_at IS NULL
            AND e.position > COALESCE((SELECT e2.position FROM episodes e2
                                       WHERE e2.novel_id = n.id AND e2.episode_key = b.last_read_episode_key), -1)) AS unread_count
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
    siteStatus: r.site_status,
    isDeletedOnSite: r.is_deleted_on_site === 1,
    note: r.note,
    lastReadEpisodeKey: r.last_read_episode_key,
    createdAt: r.created_at,
    lastBackupAt: r.last_checked_at,
    lastChangedAt: r.last_changed_at,
    lastError: r.last_error,
    /** バックアップ済みの話数(未バックアップは 0) */
    episodeCount: r.episode_count,
    /** 最後に読んだ話より後ろの話数。未バックアップは 0 */
    unreadCount: r.episode_count === 0 ? 0 : r.unread_count,
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

type NovelRef = { id: number; last_checked_at: string | null };

export function bookmarksRouter(db: Db, live: LiveService): Router {
  const router = Router();
  router.use(requireAuth);

  function getOne(userId: number, id: number): BookmarkRow | undefined {
    return db.prepare(`${SELECT} WHERE b.user_id = ? AND b.id = ?`).get(userId, id) as unknown as BookmarkRow | undefined;
  }
  function findNovel(site: SiteId, novelKey: string): NovelRef | undefined {
    return db.prepare("SELECT id, last_checked_at FROM novels WHERE site = ? AND novel_key = ?").get(site, novelKey) as unknown as
      | NovelRef
      | undefined;
  }

  function fillEmptyMeta(userId: number, bookmarkId: number, title: string, author?: string) {
    const b = getOne(userId, bookmarkId);
    if (!b) return;
    if (!b.title) db.prepare("UPDATE novels SET title = ? WHERE id = ?").run(title, b.novel_id);
    if (!b.author && author) db.prepare("UPDATE novels SET author = ? WHERE id = ?").run(author, b.novel_id);
  }

  router.get("/", (req, res) => {
    const rows = db
      .prepare(`${SELECT} WHERE b.user_id = ? ORDER BY b.created_at DESC, b.id DESC`)
      .all(req.user!.id) as unknown as BookmarkRow[];
    res.json({ bookmarks: rows.map(toBookmarkDto) });
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
        if (body.title) fillEmptyMeta(userId, existing, body.title, body.author);
        return void res.status(200).json({ bookmark: toBookmarkDto(getOne(userId, existing)!), created: false });
      }

      let novel = findNovel(site, novelKey);
      const clientMeta = body.title !== undefined;
      if (!novel && clientMeta) {
        // 呼び出し側がタイトルを渡した場合はサイトへ取得しない(Cloudflare 等で取得できないサイト向け)
        db.prepare(
          `INSERT OR IGNORE INTO novels (site, novel_key, title, author, url, site_status, created_at)
           VALUES (?, ?, ?, ?, ?, 'unknown', ?)`,
        ).run(site, novelKey, body.title!, body.author ?? "", live.getAdapter(site).novelUrl(novelKey), nowIso());
        novel = findNovel(site, novelKey)!;
      } else if (!novel) {
        // メタ情報を取得(キャッシュがあれば再利用)。サイトに存在しなければ 404、ブロック等は空メタで登録
        let meta: { title: string; author: string; url: string; status: string } | null = null;
        try {
          const info = await live.getNovel(site, novelKey);
          meta = { title: info.title, author: info.author, url: info.url, status: info.status };
        } catch (e) {
          if (e instanceof SiteNotFoundError) return sendSiteError(res, e);
          console.warn("[bookmarks] metadata fetch failed:", e instanceof Error ? e.message : e);
        }
        const url = meta?.url ?? live.getAdapter(site).novelUrl(novelKey);
        // 取得中に別リクエストが作った場合に備え OR IGNORE
        db.prepare(
          `INSERT OR IGNORE INTO novels (site, novel_key, title, author, url, site_status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(site, novelKey, meta?.title ?? "", meta?.author ?? "", url, meta?.status ?? "unknown", nowIso());
        novel = findNovel(site, novelKey)!;
      }
      db.prepare("INSERT OR IGNORE INTO bookmarks (user_id, novel_id, created_at) VALUES (?, ?, ?)").run(userId, novel.id, nowIso());
      const id = findBookmarkId(db, userId, site, novelKey)!;
      if (!clientMeta && !novel.last_checked_at) enqueueNovelBackup(novel.id, "bookmark");
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
