/** DBとのバックアップデータ保存層 */

import { Db, nowIso, transaction } from "../db/index.js";
import { normalizeSourceDate } from "./dates.js";
import { SiteId, TaskType, BackupTask, BackupRunStats, NovelMetadata, Episode, EpisodeContent } from "./types.js";

/** スクレイパーが取得失敗時に入れる "Unknown" は作者として保存しない。 */
function cleanAuthor(author: string | null | undefined): string {
  const a = (author ?? "").trim();
  return a === "Unknown" ? "" : a;
}

export class BackupRepository {
  constructor(private db: Db) {}

  listTrackedNovels(): Array<{ site: SiteId; novelKey: string }> {
    const rows = this.db
      .prepare(
        `SELECT site, novel_key
         FROM novels
         ORDER BY site, novel_key`
      )
      .all() as Array<{ site: SiteId; novel_key: string }>;

    return rows.map((row) => ({ site: row.site, novelKey: row.novel_key }));
  }

  /**
   * 起動時リカバリ: プロセス強制終了などで取り残された状態を巻き戻す。
   * - backup_tasks 'in_progress' → 'pending' (retry_count は維持)
   * - backup_tasks 'failed' → 'pending' (retry_count を 0 に戻し、再起動ごとに 1 ラウンド再試行)
   * - backup_run_stats 'in_progress' → 'failed' (finished_at と errors_json に注記)
   * UNIQUE(site, novel_key, task_type, status) に衝突する場合は取り残し側の行を削除する。
   */
  recoverInterruptedState(): { tasksReset: number; failedReset: number; runsClosed: number } {
    return transaction(this.db, () => {
      const now = nowIso();
      const rows = this.db
        .prepare(`SELECT id, status FROM backup_tasks WHERE status IN ('in_progress', 'failed')`)
        .all() as Array<{ id: number; status: string }>;
      const reset = this.db.prepare(
        `UPDATE OR IGNORE backup_tasks
         SET status = 'pending', scheduled_at = ?, started_at = NULL, completed_at = NULL,
             retry_count = CASE WHEN status = 'failed' THEN 0 ELSE retry_count END
         WHERE id = ?`
      );
      const remove = this.db.prepare(`DELETE FROM backup_tasks WHERE id = ? AND status IN ('in_progress', 'failed')`);
      let tasksReset = 0;
      let failedReset = 0;
      for (const row of rows) {
        const result = reset.run(now, row.id);
        if (Number(result.changes) > 0) {
          if (row.status === "failed") failedReset++;
          else tasksReset++;
        } else {
          // 既に同一キーの pending があるため重複行を削除
          remove.run(row.id);
        }
      }

      const note = JSON.stringify([{ timestamp: now, error: "サーバー再起動により中断されたため failed として終了" }]);
      const runs = this.db
        .prepare(
          `UPDATE backup_run_stats
           SET status = 'failed', finished_at = ?,
               errors_json = CASE WHEN errors_json IS NULL OR errors_json = '[]' THEN ? ELSE errors_json END
           WHERE status = 'in_progress'`
        )
        .run(now, note);
      return { tasksReset, failedReset, runsClosed: Number(runs.changes) };
    });
  }

  createRunStats(): BackupRunStats {
    const result = this.db
      .prepare(
        `INSERT INTO backup_run_stats (started_at, status)
         VALUES (?, ?)
         RETURNING id, started_at, finished_at, status, total_tasks, completed_tasks, failed_tasks, total_episodes_scraped, errors_json`
      )
      .get(nowIso(), "in_progress") as any;

    return {
      id: result.id,
      startedAt: result.started_at,
      finishedAt: result.finished_at,
      status: result.status,
      totalTasks: result.total_tasks,
      completedTasks: result.completed_tasks,
      failedTasks: result.failed_tasks,
      totalEpisodesScraped: result.total_episodes_scraped,
      errorsJson: result.errors_json,
    };
  }

  finishRunStats(id: number, status: "completed" | "failed"): void {
    this.db
      .prepare(
        `UPDATE backup_run_stats
         SET finished_at = ?, status = ?
         WHERE id = ?`
      )
      .run(nowIso(), status, id);
  }

  // タスク関連
  enqueueTasks(site: SiteId, novelKeys: string[], taskType: TaskType, priority: number = 0): void {
    transaction(this.db, () => {
      const selectExisting = this.db.prepare(
        `SELECT id
         FROM backup_tasks
         WHERE site = ? AND novel_key = ? AND task_type = ?
         ORDER BY id DESC
         LIMIT 1`
      );
      const updateExisting = this.db.prepare(
        `UPDATE backup_tasks
         SET status = 'pending',
             scheduled_at = ?,
             started_at = NULL,
             completed_at = NULL,
             error_message = NULL,
             retry_count = 0,
             priority = MAX(priority, ?)
         WHERE id = ?`
      );
      const insertNew = this.db.prepare(
        `INSERT INTO backup_tasks (site, novel_key, task_type, status, scheduled_at, priority, created_at)
         VALUES (?, ?, ?, 'pending', ?, ?, ?)`
      );
      const deleteOld = this.db.prepare(
        `DELETE FROM backup_tasks
         WHERE site = ? AND novel_key = ? AND task_type = ? AND id <> ?`
      );

      for (const novelKey of novelKeys) {
        const existing = selectExisting.get(site, novelKey, taskType) as { id: number } | undefined;
        if (existing) {
          updateExisting.run(nowIso(), priority, existing.id);
          deleteOld.run(site, novelKey, taskType, existing.id);
        } else {
          insertNew.run(site, novelKey, taskType, nowIso(), priority, nowIso());
        }
      }
    });
  }

  /** 次の pending タスク。targets 指定時はその作品のタスクだけを対象にする(他作品は pending のまま残る)。 */
  getNextTask(targets?: ReadonlyArray<{ site: SiteId; novelKey: string }>): BackupTask | null {
    if (targets && targets.length === 0) return null;
    const filter = targets ? ` AND (${targets.map(() => "(site = ? AND novel_key = ?)").join(" OR ")})` : "";
    const params = targets ? targets.flatMap((t) => [t.site, t.novelKey]) : [];
    const result = this.db
      .prepare(
        `SELECT id, site, novel_key, task_type, status, scheduled_at, started_at, 
                completed_at, error_message, retry_count, max_retries, priority, created_at
         FROM backup_tasks
         WHERE status = 'pending'${filter}
         ORDER BY priority DESC, scheduled_at ASC
         LIMIT 1`
      )
      .get(...params) as any;

    return result
      ? {
          id: result.id,
          site: result.site,
          novelKey: result.novel_key,
          taskType: result.task_type,
          status: result.status,
          scheduledAt: result.scheduled_at,
          startedAt: result.started_at,
          completedAt: result.completed_at,
          errorMessage: result.error_message,
          retryCount: result.retry_count,
          maxRetries: result.max_retries,
          priority: result.priority,
          createdAt: result.created_at,
        }
      : null;
  }

  startTask(taskId: number): void {
    this.db
      .prepare(`UPDATE backup_tasks SET status = 'in_progress', started_at = ? WHERE id = ?`)
      .run(nowIso(), taskId);
  }

  completeTask(taskId: number): void {
    this.db
      .prepare(`UPDATE backup_tasks SET status = 'completed', completed_at = ? WHERE id = ?`)
      .run(nowIso(), taskId);
  }

  failTask(taskId: number, error: string, maxRetries: number): void {
    transaction(this.db, () => {
      const task = this.db.prepare("SELECT retry_count FROM backup_tasks WHERE id = ?").get(taskId) as any;
      const newRetryCount = task.retry_count + 1;

      if (newRetryCount >= maxRetries) {
        this.db
          .prepare(
            `UPDATE backup_tasks SET status = 'failed', error_message = ?, completed_at = ?, retry_count = ?
           WHERE id = ?`
          )
          .run(error, nowIso(), newRetryCount, taskId);
      } else {
        this.db
          .prepare(
            `UPDATE backup_tasks SET status = 'pending', error_message = ?, retry_count = ?, scheduled_at = ?
           WHERE id = ?`
          )
          .run(error, newRetryCount, nowIso(), taskId);
      }
    });
  }

  // データ保存
  saveNovelMetadata(site: SiteId, novelKey: string, metadata: NovelMetadata): void {
    transaction(this.db, () => {
      // novel 存在確認・更新
      let novelId = (
        this.db.prepare("SELECT id FROM novels WHERE site = ? AND novel_key = ?").get(site, novelKey) as any
      )?.id;

      if (!novelId) {
        const result = this.db
          .prepare(
            `INSERT INTO novels (site, novel_key, title, author, url, created_at)
           VALUES (?, ?, ?, ?, ?, ?)
           RETURNING id`
          )
          .get(site, novelKey, metadata.title, cleanAuthor(metadata.author), metadata.url, nowIso()) as any;
        novelId = result.id;
      } else {
        this.db
          .prepare(
            `UPDATE novels SET title = ?, author = CASE WHEN ? <> '' THEN ? ELSE author END,
                last_checked_at = ?, last_backup_metadata_at = ?
           WHERE id = ?`
          )
          .run(metadata.title, cleanAuthor(metadata.author), cleanAuthor(metadata.author), nowIso(), nowIso(), novelId);
      }
    });
  }

  saveEpisodes(site: SiteId, novelKey: string, episodes: Episode[]): number {
    return transaction(this.db, () => {
      const novelId = (
        this.db.prepare("SELECT id FROM novels WHERE site = ? AND novel_key = ?").get(site, novelKey) as any
      )?.id;

      if (!novelId) throw new Error(`Novel not found: ${site}/${novelKey}`);

      let addedCount = 0;
      const stmt = this.db.prepare(
        `INSERT INTO episodes (novel_id, episode_key, position, title, chapter, site_published_at, site_updated_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(novel_id, episode_key) DO UPDATE SET
           title = excluded.title,
           site_published_at = COALESCE(excluded.site_published_at, episodes.site_published_at),
           site_updated_at = COALESCE(excluded.site_updated_at, episodes.site_updated_at)
         RETURNING id`
      );

      for (const ep of episodes) {
        stmt.run(novelId, ep.episodeKey, ep.position, ep.title, ep.chapter || null,
          normalizeSourceDate(ep.publishedAt), normalizeSourceDate(ep.updatedAt) ?? normalizeSourceDate(ep.publishedAt), nowIso());
        addedCount++;
      }

      // バックアップを完了したエピソード数とタイムスタンプを更新。
      // source_updated_at は作品としての更新日時 = 最新話の公開日時(既存話の改稿日時は含めない)
      this.db
        .prepare(
          `UPDATE novels SET last_backup_all_at = ?, backup_episode_count = ?,
             source_updated_at = (
               SELECT MAX(COALESCE(e.site_published_at, e.site_updated_at)) FROM episodes e
               WHERE e.novel_id = novels.id AND e.removed_at IS NULL
             )
           WHERE id = ?`
        )
        .run(nowIso(), episodes.length, novelId);

      return addedCount;
    });
  }

  saveEpisodeContent(
    site: SiteId,
    novelKey: string,
    episodeKey: string,
    content: EpisodeContent,
    listUpdatedAt?: string | null
  ): boolean {
    // 更新検出の基準日時: 本文側で取れなければ話一覧側の更新日時を使う
    const siteUpdatedAt = content.updatedAt || listUpdatedAt || null;
    return transaction(this.db, () => {
      const episodeId = (
        this.db.prepare(
          `SELECT ep.id FROM episodes ep
           JOIN novels n ON ep.novel_id = n.id
           WHERE n.site = ? AND n.novel_key = ? AND ep.episode_key = ?`
        ).get(site, novelKey, episodeKey) as any
      )?.id;

      if (!episodeId) {
        console.warn(`Episode not found: ${site}/${novelKey}/${episodeKey}`);
        return false;
      }

      // 空本文は保存しない(取得済み扱いになり再取得されなくなるため)
      if (!content.bodyHtml || !content.bodyHtml.trim()) {
        console.warn(`Empty body skipped: ${site}/${novelKey}/${episodeKey}`);
        return false;
      }

      // コンテンツハッシュを計算（変更検出用）
      const contentHash = this._hashContent(content.bodyHtml);

      // 最新バージョンを取得
      const lastVersion = (
        this.db
          .prepare(
            `SELECT id, version, content_hash FROM episode_versions
           WHERE episode_id = ?
           ORDER BY version DESC
           LIMIT 1`
          )
          .get(episodeId) as any
      ) || { id: null, version: 0, content_hash: null };

      // ハッシュが変わっていなければスキップ。ただし更新日時は記録し、毎回再取得されないようにする
      if (lastVersion.content_hash === contentHash) {
        if (lastVersion.id && siteUpdatedAt) {
          this.db
            .prepare(`UPDATE episode_versions SET site_updated_at = ? WHERE id = ?`)
            .run(siteUpdatedAt, lastVersion.id);
        }
        return false;
      }

      const newVersion = lastVersion.version + 1;
      this.db
        .prepare(
          `INSERT INTO episode_versions (episode_id, version, content_hash, title, preface_html, body_html, afterword_html, site_updated_at, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          episodeId,
          newVersion,
          contentHash,
          content.title,
          content.prefaceHtml || null,
          content.bodyHtml,
          content.afterwordHtml || null,
          siteUpdatedAt,
          nowIso()
        );

      return true;
    });
  }

  pickContentFetchTargets(site: SiteId, novelKey: string, episodes: Episode[], maxFetch: number): Episode[] {
    if (maxFetch <= 0 || episodes.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT ep.episode_key,
                ep.site_updated_at AS episode_updated_at,
                lv.site_updated_at AS version_updated_at,
                lv.id AS version_id,
                lv.body_len AS body_len
         FROM episodes ep
         JOIN novels n ON n.id = ep.novel_id
         LEFT JOIN (
           SELECT v1.episode_id, v1.id, v1.site_updated_at, length(v1.body_html) AS body_len
           FROM episode_versions v1
           JOIN (
             SELECT episode_id, MAX(version) AS max_version
             FROM episode_versions
             GROUP BY episode_id
           ) latest ON latest.episode_id = v1.episode_id AND latest.max_version = v1.version
         ) lv ON lv.episode_id = ep.id
         WHERE n.site = ? AND n.novel_key = ?`
      )
      .all(site, novelKey) as Array<{
      episode_key: string;
      episode_updated_at: string | null;
      version_updated_at: string | null;
      version_id: number | null;
      body_len: number | null;
    }>;

    const byKey = new Map(rows.map((row) => [row.episode_key, row]));
    const targets: Episode[] = [];
    for (const ep of episodes) {
      const existing = byKey.get(ep.episodeKey);
      if (!existing || !existing.version_id) {
        targets.push(ep);
        continue;
      }
      // 過去に本文が空で保存されたものは更新日に関係なく再取得する
      if (!existing.body_len) {
        targets.push(ep);
        continue;
      }
      const currentUpdated = ep.updatedAt || "";
      const lastFetchedUpdated = existing.version_updated_at || existing.episode_updated_at || "";
      if (currentUpdated && currentUpdated !== lastFetchedUpdated) targets.push(ep);
    }

    return targets.slice(-Math.min(maxFetch, targets.length));
  }

  listLatestEpisodeContents(site: SiteId, novelKey: string): Array<{
    episodeKey: string;
    position: number;
    title: string;
    bodyHtml: string;
    prefaceHtml: string | null;
    afterwordHtml: string | null;
    updatedAt: string | null;
    publishedAt: string | null;
    fetchedAt: string;
    version: number;
  }> {
    return this.db
      .prepare(
        `SELECT ep.episode_key AS episodeKey,
                ep.position AS position,
                COALESCE(v.title, ep.title) AS title,
                v.body_html AS bodyHtml,
                v.preface_html AS prefaceHtml,
                v.afterword_html AS afterwordHtml,
                COALESCE(NULLIF(v.site_updated_at, ''), ep.site_updated_at) AS updatedAt,
                ep.site_published_at AS publishedAt,
                v.fetched_at AS fetchedAt,
                v.version AS version
         FROM novels n
         JOIN episodes ep ON ep.novel_id = n.id
         JOIN (
           SELECT v1.episode_id, v1.version, v1.title, v1.body_html, v1.preface_html, v1.afterword_html, v1.site_updated_at, v1.fetched_at
           FROM episode_versions v1
           JOIN (
             SELECT episode_id, MAX(version) AS max_version
             FROM episode_versions
             GROUP BY episode_id
           ) latest ON latest.episode_id = v1.episode_id AND latest.max_version = v1.version
         ) v ON v.episode_id = ep.id
         WHERE n.site = ? AND n.novel_key = ?
         ORDER BY ep.position ASC`
      )
      .all(site, novelKey) as Array<{
      episodeKey: string;
      position: number;
      title: string;
      bodyHtml: string;
      prefaceHtml: string | null;
      afterwordHtml: string | null;
      updatedAt: string | null;
      publishedAt: string | null;
      fetchedAt: string;
      version: number;
    }>;
  }

  private _hashContent(html: string): string {
    // 簡易的なハッシュ関数
    let hash = 0;
    for (let i = 0; i < html.length; i++) {
      const char = html.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(36);
  }

  updateRunStatsTotals(statsId: number, totalTasks: number): void {
    this.db
      .prepare(`UPDATE backup_run_stats SET total_tasks = ? WHERE id = ?`)
      .run(totalTasks, statsId);
  }

  incrementRunStatsCompleted(statsId: number, episodeCount: number = 0): void {
    this.db
      .prepare(
        `UPDATE backup_run_stats
         SET completed_tasks = completed_tasks + 1, total_episodes_scraped = total_episodes_scraped + ?
         WHERE id = ?`
      )
      .run(episodeCount, statsId);
  }

  incrementRunStatsFailed(statsId: number, error: string): void {
    transaction(this.db, () => {
      const stats = this.db.prepare("SELECT errors_json FROM backup_run_stats WHERE id = ?").get(statsId) as any;
      const errors = JSON.parse(stats.errors_json || "[]");
      errors.push({ timestamp: nowIso(), error });

      this.db
        .prepare(
          `UPDATE backup_run_stats
         SET failed_tasks = failed_tasks + 1, errors_json = ?
         WHERE id = ?`
        )
        .run(JSON.stringify(errors), statsId);
    });
  }

  // 統計情報
  getTaskStats(): { pending: number; inProgress: number; completed: number; failed: number } {
    const stats = this.db
      .prepare(
        `SELECT
         SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
         SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress,
         SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
         FROM backup_tasks`
      )
      .get() as any;

    return {
      pending: stats.pending || 0,
      inProgress: stats.in_progress || 0,
      completed: stats.completed || 0,
      failed: stats.failed || 0,
    };
  }
}
