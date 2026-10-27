import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requireAdmin, requireAuth } from "../auth/session.js";
import type { BackupScheduler } from "../backup/scheduler.js";
import type { Db } from "../db/index.js";
import { parseBody, sendError } from "../http/errors.js";
import { htmlToText } from "../sites/sanitize.js";

interface NovelRow {
  id: number;
  site: string;
  novel_key: string;
  title: string;
  author: string;
  url: string;
  site_status: string;
  is_deleted_on_site: number;
  created_at: string;
  last_checked_at: string | null;
  last_changed_at: string | null;
  last_error: string | null;
  episode_count: number;
  removed_count: number;
  unfetched_count: number;
  version_count: number;
  bookmarked: number;
}

/** 閲覧者は自分がブックマーク中の作品のみ、admin は全作品。 */
const NOVEL_SELECT = (userId: number) => `
  SELECT n.id, n.site, n.novel_key, n.title, n.author, n.url, n.site_status, n.is_deleted_on_site,
         n.created_at, n.last_checked_at, n.last_changed_at, n.last_error,
         (SELECT COUNT(*) FROM episodes e WHERE e.novel_id = n.id AND e.removed_at IS NULL) AS episode_count,
         (SELECT COUNT(*) FROM episodes e WHERE e.novel_id = n.id AND e.removed_at IS NOT NULL) AS removed_count,
         (SELECT COUNT(*) FROM episodes e WHERE e.novel_id = n.id AND e.removed_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM episode_versions v WHERE v.episode_id = e.id)) AS unfetched_count,
         (SELECT COUNT(*) FROM episode_versions v JOIN episodes e ON e.id = v.episode_id WHERE e.novel_id = n.id) AS version_count,
         EXISTS (SELECT 1 FROM bookmarks b WHERE b.novel_id = n.id AND b.user_id = ${Number(userId)}) AS bookmarked
  FROM novels n`;

function novelDto(r: NovelRow, scheduler: BackupScheduler) {
  return {
    id: r.id,
    site: r.site,
    novelKey: r.novel_key,
    title: r.title,
    author: r.author,
    url: r.url,
    siteStatus: r.site_status,
    isDeletedOnSite: r.is_deleted_on_site === 1,
    createdAt: r.created_at,
    lastCheckedAt: r.last_checked_at,
    lastChangedAt: r.last_changed_at,
    lastError: r.last_error,
    /** 現在の目次にある話数 */
    episodeCount: r.episode_count,
    /** 目次から消えた話数 */
    removedCount: r.removed_count,
    /** まだ本文を取得していない話数(大長編の分割取得中など) */
    unfetchedCount: r.unfetched_count,
    versionCount: r.version_count,
    bookmarked: r.bookmarked === 1,
    queued: scheduler.isQueued(r.id),
  };
}

interface VersionRow {
  version: number;
  content_hash: string;
  title: string;
  preface_html: string | null;
  body_html: string;
  afterword_html: string | null;
  site_updated_at: string | null;
  fetched_at: string;
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

const runBodySchema = z.object({ force: z.boolean().optional() }).strict();

export function backupsRouter(db: Db, scheduler: BackupScheduler): Router {
  const router = Router();
  router.use(requireAuth);

  /** アクセス可能な作品行を返す。不可/不在は 404 を返して null(存在の有無を漏らさない)。 */
  function loadNovel(req: Request, res: Response): NovelRow | null {
    const id = Number(req.params.id);
    const user = req.user!;
    const row = Number.isInteger(id)
      ? (db.prepare(`${NOVEL_SELECT(user.id)} WHERE n.id = ?`).get(id) as unknown as NovelRow | undefined)
      : undefined;
    if (!row || (user.role !== "admin" && row.bookmarked !== 1)) {
      sendError(res, 404, "not_found");
      return null;
    }
    return row;
  }

  router.get("/status", (_req, res) => {
    res.json(scheduler.status());
  });

  router.get("/runs", requireAdmin, (_req, res) => {
    const rows = db.prepare("SELECT * FROM backup_runs ORDER BY id DESC LIMIT 50").all() as unknown as {
      id: number;
      trigger: string;
      started_at: string;
      finished_at: string | null;
      status: string;
      novels_checked: number;
      episodes_fetched: number;
      versions_added: number;
      errors_json: string;
    }[];
    res.json({
      runs: rows.map((r) => ({
        id: r.id,
        trigger: r.trigger,
        startedAt: r.started_at,
        finishedAt: r.finished_at,
        status: r.status,
        novelsChecked: r.novels_checked,
        episodesFetched: r.episodes_fetched,
        versionsAdded: r.versions_added,
        errors: safeJson(r.errors_json) ?? [],
      })),
    });
  });

  router.post("/run", requireAdmin, (req, res) => {
    const body = parseBody(runBodySchema, req, res);
    if (!body) return;
    const r = scheduler.runAll({ trigger: "manual", force: body.force });
    if (!r.started) return sendError(res, 409, "already_running", "既に実行中です");
    res.status(202).json({ started: true, runId: r.runId });
  });

  router.get("/novels", (req, res) => {
    const user = req.user!;
    const where = user.role === "admin" ? "" : `WHERE EXISTS (SELECT 1 FROM bookmarks b WHERE b.novel_id = n.id AND b.user_id = ${Number(user.id)})`;
    const rows = db
      .prepare(`${NOVEL_SELECT(user.id)} ${where} ORDER BY COALESCE(n.last_changed_at, n.created_at) DESC, n.id DESC`)
      .all() as unknown as NovelRow[];
    res.json({ novels: rows.map((r) => novelDto(r, scheduler)) });
  });

  router.get("/novels/:id", (req, res) => {
    const novel = loadNovel(req, res);
    if (!novel) return;
    const metaRows = db
      .prepare("SELECT version, hash, meta_json, toc_json, fetched_at FROM novel_meta_versions WHERE novel_id = ? ORDER BY version DESC")
      .all(novel.id) as unknown as { version: number; hash: string; meta_json: string; toc_json: string; fetched_at: string }[];
    const metaVersions = metaRows.map((m) => ({
      version: m.version,
      hash: m.hash,
      fetchedAt: m.fetched_at,
      tocCount: (safeJson(m.toc_json) as unknown[] | null)?.length ?? 0,
      meta: safeJson(m.meta_json),
    }));
    const eps = db
      .prepare(
        `SELECT e.id, e.episode_key, e.position, e.title, e.chapter, e.site_published_at, e.site_updated_at, e.removed_at,
                (SELECT COUNT(*) FROM episode_versions v WHERE v.episode_id = e.id) AS version_count,
                (SELECT MAX(v.fetched_at) FROM episode_versions v WHERE v.episode_id = e.id) AS last_fetched_at
         FROM episodes e WHERE e.novel_id = ?
         ORDER BY (e.removed_at IS NOT NULL) ASC, e.position ASC, e.id ASC`,
      )
      .all(novel.id) as unknown as {
      id: number;
      episode_key: string;
      position: number;
      title: string;
      chapter: string | null;
      site_published_at: string | null;
      site_updated_at: string | null;
      removed_at: string | null;
      version_count: number;
      last_fetched_at: string | null;
    }[];
    res.json({
      novel: novelDto(novel, scheduler),
      meta: metaVersions[0]?.meta ?? null,
      metaVersions,
      episodes: eps.map((e) => ({
        id: e.id,
        episodeKey: e.episode_key,
        position: e.position,
        title: e.title,
        chapter: e.chapter,
        publishedAt: e.site_published_at,
        siteUpdatedAt: e.site_updated_at,
        removedAt: e.removed_at,
        versionCount: e.version_count,
        lastFetchedAt: e.last_fetched_at,
      })),
    });
  });

  /** 話の指定版(省略時は最新)を返す。 */
  function sendEpisode(req: Request, res: Response, wanted: number | "latest") {
    const novel = loadNovel(req, res);
    if (!novel) return;
    const epId = Number(req.params.episodeId);
    const ep = Number.isInteger(epId)
      ? (db
          .prepare("SELECT id, episode_key, position, title, chapter, site_published_at, site_updated_at, removed_at FROM episodes WHERE id = ? AND novel_id = ?")
          .get(epId, novel.id) as unknown as
          | {
              id: number;
              episode_key: string;
              position: number;
              title: string;
              chapter: string | null;
              site_published_at: string | null;
              site_updated_at: string | null;
              removed_at: string | null;
            }
          | undefined)
      : undefined;
    if (!ep) return sendError(res, 404, "not_found");
    const versions = db
      .prepare("SELECT version, fetched_at, site_updated_at, content_hash FROM episode_versions WHERE episode_id = ? ORDER BY version ASC")
      .all(ep.id) as unknown as { version: number; fetched_at: string; site_updated_at: string | null; content_hash: string }[];
    if (versions.length === 0) return sendError(res, 404, "no_versions", "この話の本文はまだバックアップされていません");
    const v = wanted === "latest" ? versions[versions.length - 1]!.version : wanted;
    const row = db
      .prepare(
        `SELECT version, content_hash, title, preface_html, body_html, afterword_html, site_updated_at, fetched_at
         FROM episode_versions WHERE episode_id = ? AND version = ?`,
      )
      .get(ep.id, v) as unknown as VersionRow | undefined;
    if (!row) return sendError(res, 404, "not_found");

    // 前後の話(現在の目次にあり、本文を取得済みの話)
    let prevEpisodeId: number | null = null;
    let nextEpisodeId: number | null = null;
    if (ep.removed_at === null) {
      const nav = (cmp: string, order: string) =>
        (
          db
            .prepare(
              `SELECT e.id FROM episodes e WHERE e.novel_id = ? AND e.removed_at IS NULL AND e.position ${cmp} ?
               AND EXISTS (SELECT 1 FROM episode_versions v WHERE v.episode_id = e.id)
               ORDER BY e.position ${order} LIMIT 1`,
            )
            .get(novel.id, ep.position) as unknown as { id: number } | undefined
        )?.id ?? null;
      prevEpisodeId = nav("<", "DESC");
      nextEpisodeId = nav(">", "ASC");
    }
    res.json({
      novel: { id: novel.id, site: novel.site, novelKey: novel.novel_key, title: novel.title, url: novel.url },
      episode: {
        id: ep.id,
        episodeKey: ep.episode_key,
        position: ep.position,
        title: ep.title,
        chapter: ep.chapter,
        publishedAt: ep.site_published_at,
        siteUpdatedAt: ep.site_updated_at,
        removedAt: ep.removed_at,
        prevEpisodeId,
        nextEpisodeId,
      },
      version: {
        version: row.version,
        contentHash: row.content_hash,
        title: row.title,
        prefaceHtml: row.preface_html,
        bodyHtml: row.body_html,
        afterwordHtml: row.afterword_html,
        siteUpdatedAt: row.site_updated_at,
        fetchedAt: row.fetched_at,
      },
      versions: versions.map((x) => ({
        version: x.version,
        fetchedAt: x.fetched_at,
        siteUpdatedAt: x.site_updated_at,
        contentHash: x.content_hash,
      })),
    });
  }

  router.get("/novels/:id/episodes/:episodeId", (req, res) => sendEpisode(req, res, "latest"));
  router.get("/novels/:id/episodes/:episodeId/versions/:version", (req, res) => {
    const v = Number(req.params.version);
    if (!Number.isInteger(v) || v < 1) return sendError(res, 404, "not_found");
    sendEpisode(req, res, v);
  });

  router.post("/novels/:id/run", (req, res) => {
    const novel = loadNovel(req, res);
    if (!novel) return;
    const body = parseBody(runBodySchema, req, res);
    if (!body) return;
    // 全話再取得(force)は負荷が大きいため admin のみ
    const force = !!body.force && req.user!.role === "admin";
    const r = scheduler.enqueue(novel.id, "novel", { force });
    res.status(202).json({ queued: r === "queued", alreadyQueued: r === "duplicate" });
  });

  router.delete("/novels/:id", requireAdmin, (req, res) => {
    const novel = loadNovel(req, res);
    if (!novel) return;
    db.prepare("DELETE FROM novels WHERE id = ?").run(novel.id);
    res.json({ ok: true });
  });

  router.get("/novels/:id/export", (req, res) => {
    const novel = loadNovel(req, res);
    if (!novel) return;
    const format = req.query.format === "html" ? "html" : req.query.format === "txt" || req.query.format === undefined ? "txt" : null;
    if (!format) return sendError(res, 400, "validation_error", "format は txt または html");
    const meta = safeJson(
      (
        db.prepare("SELECT meta_json FROM novel_meta_versions WHERE novel_id = ? ORDER BY version DESC LIMIT 1").get(novel.id) as unknown as
          | { meta_json: string }
          | undefined
      )?.meta_json ?? "null",
    ) as { synopsis?: string } | null;
    // 現在の目次の話の最新版(目次から消えた話は末尾)
    const rows = db
      .prepare(
        `SELECT e.chapter, e.removed_at, v.title, v.preface_html, v.body_html, v.afterword_html
         FROM episodes e JOIN episode_versions v ON v.episode_id = e.id
           AND v.version = (SELECT MAX(version) FROM episode_versions WHERE episode_id = e.id)
         WHERE e.novel_id = ?
         ORDER BY (e.removed_at IS NOT NULL) ASC, e.position ASC, e.id ASC`,
      )
      .all(novel.id) as unknown as {
      chapter: string | null;
      removed_at: string | null;
      title: string;
      preface_html: string | null;
      body_html: string;
      afterword_html: string | null;
    }[];

    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    let out: string;
    if (format === "txt") {
      const parts = [`${novel.title}\n${novel.author}\n${novel.url}`];
      if (meta?.synopsis) parts.push(meta.synopsis);
      let chapter: string | null = null;
      for (const r of rows) {
        const lines: string[] = [];
        if (r.chapter && r.chapter !== chapter) lines.push(`■ ${r.chapter}`);
        chapter = r.chapter;
        lines.push(`## ${r.title}${r.removed_at ? "(サイトから削除済み)" : ""}`);
        if (r.preface_html) lines.push(htmlToText(r.preface_html), "----");
        lines.push(htmlToText(r.body_html));
        if (r.afterword_html) lines.push("----", htmlToText(r.afterword_html));
        parts.push(lines.join("\n\n"));
      }
      out = parts.join("\n\n\n") + "\n";
    } else {
      const body: string[] = [`<h1>${esc(novel.title)}</h1>`, `<p>${esc(novel.author)}</p>`];
      if (meta?.synopsis) body.push(`<p>${esc(meta.synopsis).replace(/\n/g, "<br>")}</p>`);
      let chapter: string | null = null;
      for (const r of rows) {
        if (r.chapter && r.chapter !== chapter) body.push(`<h2>${esc(r.chapter)}</h2>`);
        chapter = r.chapter;
        body.push(`<section><h3>${esc(r.title)}${r.removed_at ? "(サイトから削除済み)" : ""}</h3>`);
        if (r.preface_html) body.push(`<div class="preface">${r.preface_html}</div><hr>`);
        body.push(`<div class="body">${r.body_html}</div>`);
        if (r.afterword_html) body.push(`<hr><div class="afterword">${r.afterword_html}</div>`);
        body.push("</section>");
      }
      out = `<!doctype html>\n<html lang="ja"><head><meta charset="utf-8"><title>${esc(novel.title)}</title>\n<style>body{max-width:44em;margin:2em auto;padding:0 1em;line-height:1.8;font-family:serif}section{margin:3em 0}</style>\n</head><body>\n${body.join("\n")}\n</body></html>\n`;
    }
    const safe = (novel.title || novel.novel_key).replace(/[\\/:*?"<>|\r\n]+/g, "_").slice(0, 80);
    res.setHeader("Content-Type", format === "txt" ? "text/plain; charset=utf-8" : "text/html; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="export.${format}"; filename*=UTF-8''${encodeURIComponent(`${safe}.${format}`)}`);
    // html エクスポートは保存用。ブラウザで直接開かれた場合に備えスクリプトは実行させない
    res.setHeader("Content-Security-Policy", "script-src 'none'; sandbox");
    res.send(out);
  });

  return router;
}
