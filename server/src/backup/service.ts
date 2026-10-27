import { nowIso, transaction, type Db } from "../db/index.js";
import { getSettings } from "../settings.js";
import { SiteBlockedError, SiteNotFoundError, type SiteAdapter, type SiteId, type TocEntry } from "../sites/types.js";
import { episodeContentHash, metaHash, pickMeta, pickToc } from "./hash.js";

export interface BackupNovelOptions {
  /** 更新日時に関わらず全話の本文を再取得してハッシュ比較する */
  force?: boolean;
  /** maxEpisodesPerNovelPerRun の上書き(省略時は設定値) */
  maxEpisodes?: number;
  log?: (msg: string) => void;
}

export interface BackupNovelResult {
  novelId: number;
  /** ok=エラーなし / partial=一部の話の取得に失敗 / failed=作品の取得自体に失敗 */
  status: "ok" | "partial" | "failed";
  episodesFetched: number;
  versionsAdded: number;
  errors: string[];
  deletedOnSite: boolean;
}

interface NovelRow {
  id: number;
  site: SiteId;
  novel_key: string;
}

interface LatestVersion {
  version: number;
  content_hash: string;
  site_updated_at: string | null;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * 作品 1 件のバックアップ (docs/05_backup.md)。例外は投げず、結果に errors を積む。
 * 1. fetchNovel 2. novels 更新 3. メタ版 4. 目次同期 5-6. 対象話の本文取得と版追加 7. 時刻更新
 */
export async function backupNovel(
  db: Db,
  getAdapter: (site: SiteId) => SiteAdapter,
  novelId: number,
  opts: BackupNovelOptions = {},
): Promise<BackupNovelResult> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const result: BackupNovelResult = { novelId, status: "ok", episodesFetched: 0, versionsAdded: 0, errors: [], deletedOnSite: false };

  const novel = db.prepare("SELECT id, site, novel_key FROM novels WHERE id = ?").get(novelId) as unknown as NovelRow | undefined;
  if (!novel) {
    result.status = "failed";
    result.errors.push("作品が存在しません");
    return result;
  }
  const label = `${novel.site}/${novel.novel_key}`;
  const adapter = getAdapter(novel.site);
  const setError = (m: string) => db.prepare("UPDATE novels SET last_error = ? WHERE id = ?").run(m, novelId);

  // 1. 作品取得
  let info;
  try {
    info = await adapter.fetchNovel(novel.novel_key, { priority: "normal" });
  } catch (e) {
    result.status = "failed";
    if (e instanceof SiteNotFoundError) {
      // サイト上から消えた: データは消さずフラグのみ
      result.deletedOnSite = true;
      db.prepare("UPDATE novels SET is_deleted_on_site = 1, last_error = ? WHERE id = ?").run(
        "サイト上に作品が見つかりません(削除された可能性)",
        novelId,
      );
      result.errors.push("サイト上に作品が見つかりません");
    } else if (e instanceof SiteBlockedError) {
      // ブロックは削除扱いにしない
      const m = `サイトにブロックされました(${e.reason}): ${e.message}`;
      setError(m);
      result.errors.push(m);
    } else {
      const m = `作品の取得に失敗: ${msg(e)}`;
      setError(m);
      result.errors.push(m);
    }
    log(`[backup] novel=${label} failed: ${result.errors[0]}`);
    return result;
  }

  const now = nowIso();
  const toc = info.episodes;
  const tocByKey = new Map<string, TocEntry>(toc.map((t) => [t.episodeKey, t]));

  // 目次が空なのに既存の話がある場合はパース異常とみなし、同期しない(全話を removed にしない)
  const existingCount = (db.prepare("SELECT COUNT(*) AS c FROM episodes WHERE novel_id = ?").get(novelId) as unknown as { c: number }).c;
  if (toc.length === 0 && existingCount > 0) {
    const m = "目次が空だったため同期を中止しました";
    setError(m);
    result.status = "failed";
    result.errors.push(m);
    log(`[backup] novel=${label} failed: ${m}`);
    return result;
  }

  let changed = false;
  transaction(db, () => {
    // 2. novels 更新(タイトル・作者が空のブックマークもここで補完される)
    db.prepare("UPDATE novels SET title = ?, author = ?, url = ?, site_status = ?, is_deleted_on_site = 0 WHERE id = ?").run(
      info.title,
      info.author,
      info.url,
      info.status,
      novelId,
    );

    // 3. メタ版
    const hash = metaHash(info);
    const last = db
      .prepare("SELECT version, hash FROM novel_meta_versions WHERE novel_id = ? ORDER BY version DESC LIMIT 1")
      .get(novelId) as unknown as { version: number; hash: string } | undefined;
    if (!last || last.hash !== hash) {
      db.prepare(
        "INSERT INTO novel_meta_versions (novel_id, version, hash, meta_json, toc_json, fetched_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(novelId, (last?.version ?? 0) + 1, hash, JSON.stringify(pickMeta(info)), JSON.stringify(pickToc(toc)), now);
      result.versionsAdded++;
      changed = true;
    }

    // 4. 目次同期
    const upsert = db.prepare(
      `INSERT INTO episodes (novel_id, episode_key, position, title, chapter, site_published_at, site_updated_at, removed_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)
       ON CONFLICT(novel_id, episode_key) DO UPDATE SET
         position = excluded.position, title = excluded.title, chapter = excluded.chapter,
         site_published_at = excluded.site_published_at, site_updated_at = excluded.site_updated_at, removed_at = NULL`,
    );
    for (const t of toc) {
      upsert.run(novelId, t.episodeKey, t.index, t.title, t.chapter ?? null, t.publishedAt ?? null, t.updatedAt ?? null, now);
    }
    const live = db.prepare("SELECT id, episode_key FROM episodes WHERE novel_id = ? AND removed_at IS NULL").all(novelId) as unknown as {
      id: number;
      episode_key: string;
    }[];
    const mark = db.prepare("UPDATE episodes SET removed_at = ? WHERE id = ?");
    for (const e of live) if (!tocByKey.has(e.episode_key)) mark.run(now, e.id);
  });

  // 5. 本文取得対象
  const latestStmt = db.prepare(
    "SELECT version, content_hash, site_updated_at FROM episode_versions WHERE episode_id = ? ORDER BY version DESC LIMIT 1",
  );
  const rows = db
    .prepare("SELECT id, episode_key FROM episodes WHERE novel_id = ? AND removed_at IS NULL ORDER BY position ASC, id ASC")
    .all(novelId) as unknown as { id: number; episode_key: string }[];
  let targets = rows.filter((r) => {
    if (opts.force) return true;
    const latest = latestStmt.get(r.id) as unknown as LatestVersion | undefined;
    if (!latest) return true;
    return (latest.site_updated_at ?? null) !== (tocByKey.get(r.episode_key)?.updatedAt ?? null);
  });
  const max = opts.maxEpisodes ?? getSettings(db).maxEpisodesPerNovelPerRun;
  if (max > 0 && targets.length > max) targets = targets.slice(0, max);

  // 6. 本文取得
  for (const t of targets) {
    try {
      const c = await adapter.fetchEpisode(novel.novel_key, t.episode_key, { priority: "normal" });
      result.episodesFetched++;
      const hash = episodeContentHash(c);
      const siteUpdatedAt = tocByKey.get(t.episode_key)?.updatedAt ?? null;
      const latest = latestStmt.get(t.id) as unknown as LatestVersion | undefined;
      if (!latest || latest.content_hash !== hash) {
        db.prepare(
          `INSERT INTO episode_versions
             (episode_id, version, content_hash, title, preface_html, body_html, afterword_html, site_updated_at, fetched_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(t.id, (latest?.version ?? 0) + 1, hash, c.title, c.prefaceHtml ?? null, c.bodyHtml, c.afterwordHtml ?? null, siteUpdatedAt, nowIso());
        result.versionsAdded++;
        changed = true;
      } else if ((latest.site_updated_at ?? null) !== siteUpdatedAt) {
        // 本文は同一で更新日時だけ変わった: 次回以降の再取得を避けるため記録を更新
        db.prepare("UPDATE episode_versions SET site_updated_at = ? WHERE episode_id = ? AND version = ?").run(
          siteUpdatedAt,
          t.id,
          latest.version,
        );
      }
    } catch (e) {
      if (e instanceof SiteBlockedError) {
        result.errors.push(`話 ${t.episode_key}: ブロックされました(${e.reason})。中断します`);
        break;
      }
      result.errors.push(`話 ${t.episode_key}: ${e instanceof SiteNotFoundError ? "サイト上に見つかりません" : msg(e)}`);
    }
  }

  // 7. 時刻・エラー
  const done = nowIso();
  if (result.errors.length === 0) {
    db.prepare("UPDATE novels SET last_checked_at = ?, last_error = NULL WHERE id = ?").run(done, novelId);
  } else {
    result.status = "partial";
    db.prepare("UPDATE novels SET last_checked_at = ?, last_error = ? WHERE id = ?").run(
      done,
      result.errors.slice(0, 3).join(" / "),
      novelId,
    );
  }
  if (changed) db.prepare("UPDATE novels SET last_changed_at = ? WHERE id = ?").run(done, novelId);
  log(
    `[backup] novel=${label} fetched=${result.episodesFetched} added=${result.versionsAdded}${result.errors.length ? ` errors=${result.errors.length}` : ""}`,
  );
  return result;
}
