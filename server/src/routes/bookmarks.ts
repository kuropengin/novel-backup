import { Router } from "express";
import { z } from "zod";
import type { Db } from "../db/index.js";
import { nowIso, transaction } from "../db/index.js";
import { ah, parseBody, sendError } from "../http/errors.js";
import { isSiteId, novelUrl, resolveUrl, SITE_IDS, type SiteId } from "../sites.js";
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
    backupEnabled: z.boolean().optional(),
  })
  .strict();

const listQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  site: z.enum(SITE_IDS as [SiteId, ...SiteId[]]).optional(),
  sort: z.enum(["added", "updated", "title", "site"]).default("added"),
  order: z.enum(["asc", "desc"]).default("desc"),
  // limit 省略時は全件(旧アプリ互換)
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).default(0),
});

const bulkIds = z.array(z.number().int().positive()).min(1).max(500);
const bulkSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("delete"), ids: bulkIds }).strict(),
  z.object({ action: z.literal("setBackupEnabled"), ids: bulkIds, enabled: z.boolean() }).strict(),
]);

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
  source_updated_at: string | null;
  read_episode_count: number;
  last_read_at: string | null;
  last_read_position: number | null;
  backup_enabled: number;
}

// 既読は reading_progress(ユーザー別)。最終既読話は read_at が最新のもの(なければ bookmarks.last_read_episode_key)
const PROGRESS_WHERE = "rp.user_id = b.user_id AND rp.site = n.site AND rp.novel_key = n.novel_key";
const FROM = "FROM bookmarks b JOIN novels n ON n.id = b.novel_id";
const INNER = `
    SELECT b.id, b.novel_id, b.note, b.created_at, b.backup_enabled,
           n.site, n.novel_key, n.title, n.author, n.url,
           n.last_backup_metadata_at, n.last_backup_all_at, n.backup_episode_count,
           n.source_updated_at,
           (SELECT COUNT(*) FROM reading_progress rp WHERE ${PROGRESS_WHERE}) AS read_episode_count,
           COALESCE(
             (SELECT rp.episode_key FROM reading_progress rp WHERE ${PROGRESS_WHERE} ORDER BY rp.read_at DESC, rp.episode_key DESC LIMIT 1),
             b.last_read_episode_key
           ) AS last_read_episode_key,
           (SELECT rp.read_at FROM reading_progress rp WHERE ${PROGRESS_WHERE} ORDER BY rp.read_at DESC, rp.episode_key DESC LIMIT 1) AS last_read_at
    ${FROM}`;

/**
 * where は内側(b / n を参照可)、orderLimit は外側(列名のみ参照可)に付く。
 * last_read_position は最終既読話の話番号(作品詳細の「最終既読: 第N話」用。本文一覧を取得せずに出すため)
 */
function selectBookmarks(where: string, orderLimit = ""): string {
  return `SELECT x.*,
    (SELECT e.position FROM episodes e WHERE e.novel_id = x.novel_id AND e.episode_key = x.last_read_episode_key) AS last_read_position
    FROM (${INNER} ${where}) x ${orderLimit}`;
}

/** 作者が未取得(空 / スクレイパーの取得失敗値 "Unknown")か。 */
export function isBlankAuthor(a: string | null | undefined): boolean {
  const t = (a ?? "").trim();
  return t === "" || t === "Unknown";
}

export function toBookmarkDto(r: BookmarkRow) {
  return {
    id: r.id,
    novelId: r.novel_id,
    site: r.site,
    novelKey: r.novel_key,
    title: r.title,
    author: isBlankAuthor(r.author) ? "" : r.author,
    url: r.url,
    note: r.note,
    lastReadEpisodeKey: r.last_read_episode_key,
    lastReadAt: r.last_read_at,
    readEpisodeCount: r.read_episode_count,
    sourceUpdatedAt: r.source_updated_at,
    createdAt: r.created_at,
    lastBackupMetadataAt: (r as any).last_backup_metadata_at ?? null,
    lastBackupAllAt: (r as any).last_backup_all_at ?? null,
    backupEpisodeCount: (r as any).backup_episode_count ?? 0,
    lastReadPosition: r.last_read_position ?? null,
    backupEnabled: r.backup_enabled !== 0,
  };
}

/**
 * 自動バックアップが有効なお気に入りが残っていない作品の、未実行(待機・失敗)タスクを取り消す。
 * 実行中のタスクには触れない。作品データは残す
 */
function cancelUntrackedTasks(db: Db, novelIds: readonly number[]): void {
  const stmt = db.prepare(
    `DELETE FROM backup_tasks
     WHERE status IN ('pending', 'failed')
       AND (site, novel_key) = (SELECT site, novel_key FROM novels WHERE id = ?)
       AND NOT EXISTS (SELECT 1 FROM bookmarks WHERE novel_id = ? AND backup_enabled = 1)`,
  );
  for (const id of new Set(novelIds)) stmt.run(id, id);
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
    return db.prepare(selectBookmarks("WHERE b.user_id = ? AND b.id = ?")).get(userId, id) as unknown as BookmarkRow | undefined;
  }
  /** ユーザー自身のお気に入りのうち、ids に含まれるもの(他人の id・存在しない id は除外) */
  function ownedNovelIds(userId: number, ids: readonly number[]): Array<{ id: number; novel_id: number }> {
    return db
      .prepare(`SELECT id, novel_id FROM bookmarks WHERE user_id = ? AND id IN (${ids.map(() => "?").join(",")})`)
      .all(userId, ...ids) as unknown as Array<{ id: number; novel_id: number }>;
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
    if (isBlankAuthor(b.author) && author) db.prepare("UPDATE novels SET author = ? WHERE id = ?").run(author, b.novel_id);
  }

  // q: タイトル/作者/サイト(id・日本語名)の部分一致。site: サイトで絞り込み。sort: added|updated|title|site(updated は元サイトでの最新話更新日時 source_updated_at。未取得は常に末尾)
  // limit/offset でページ単位に取得できる。total は絞り込み後の全件数
  router.get("/", (req, res) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) return void res.status(400).json({ error: "validation_error", details: parsed.error.issues });
    const { q, site, sort, order, limit, offset } = parsed.data;
    const dir = order === "asc" ? "ASC" : "DESC";
    const orderBy =
      sort === "title"
        ? `title COLLATE NOCASE ${dir}, id DESC`
        : sort === "site"
          ? `site ${dir}, created_at DESC, id DESC`
          : sort === "updated"
            ? `(source_updated_at IS NULL) ASC, source_updated_at ${dir}, created_at DESC, id DESC`
            : `created_at ${dir}, id ${dir}`;
    const params: (string | number)[] = [req.user!.id];
    let where = "WHERE b.user_id = ?";
    if (site) {
      where += " AND n.site = ?";
      params.push(site);
    }
    if (q) {
      const like = `%${escapeLike(q)}%`;
      where += ` AND (n.title LIKE ? ESCAPE '!' OR n.author LIKE ? ESCAPE '!' OR n.site LIKE ? ESCAPE '!' OR ${SITE_LABEL_SQL} LIKE ? ESCAPE '!')`;
      params.push(like, like, like, like);
    }
    const total = (db.prepare(`SELECT COUNT(*) AS c ${FROM} ${where}`).get(...params) as unknown as { c: number }).c;
    const page = limit === undefined ? "" : "LIMIT ? OFFSET ?";
    const pageParams = limit === undefined ? [] : [limit, offset];
    const rows = db
      .prepare(selectBookmarks(where, `ORDER BY ${orderBy} ${page}`))
      .all(...params, ...pageParams) as unknown as BookmarkRow[];
    res.json({ bookmarks: rows.map(toBookmarkDto), total });
  });

  // 複数のお気に入りをまとめて削除 / 自動バックアップの有効・無効を切り替える。他人の id は無視する
  router.post("/bulk", (req, res) => {
    const body = parseBody(bulkSchema, req, res);
    if (!body) return;
    const userId = req.user!.id;
    const owned = ownedNovelIds(userId, body.ids);
    transaction(db, () => {
      const ids = owned.map((b) => b.id);
      if (ids.length === 0) return;
      const inIds = ids.map(() => "?").join(",");
      if (body.action === "delete") {
        db.prepare(`DELETE FROM bookmarks WHERE user_id = ? AND id IN (${inIds})`).run(userId, ...ids);
      } else {
        db.prepare(`UPDATE bookmarks SET backup_enabled = ? WHERE user_id = ? AND id IN (${inIds})`).run(body.enabled ? 1 : 0, userId, ...ids);
      }
      cancelUntrackedTasks(
        db,
        owned.map((b) => b.novel_id),
      );
    });
    res.json({ ok: true, affected: owned.length });
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
    if (body.backupEnabled !== undefined) {
      transaction(db, () => {
        db.prepare("UPDATE bookmarks SET backup_enabled = ? WHERE id = ? AND user_id = ?").run(body.backupEnabled ? 1 : 0, id, userId);
        cancelUntrackedTasks(db, [getOne(userId, id)!.novel_id]);
      });
    }
    res.json({ bookmark: toBookmarkDto(getOne(userId, id)!) });
  });

  router.delete("/:id", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return sendError(res, 404, "not_found");
    const target = getOne(req.user!.id, id);
    if (!target) return sendError(res, 404, "not_found");
    transaction(db, () => {
      db.prepare("DELETE FROM bookmarks WHERE id = ? AND user_id = ?").run(id, req.user!.id);
      cancelUntrackedTasks(db, [target.novel_id]);
    });
    res.json({ ok: true });
  });

  return router;
}
