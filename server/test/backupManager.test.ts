import { describe, expect, it, vi } from "vitest";
import { BackupManager } from "../src/backup/manager.js";
import { BackupScheduler } from "../src/backup/scheduler.js";
import { BaseScraper } from "../src/backup/scrapers.js";
import type { BackupConfig, Episode, EpisodeContent, NovelMetadata, SiteId } from "../src/backup/types.js";

import { nowIso, openDb, type Db } from "../src/db/index.js";

const CONFIG: BackupConfig = {
  maxParallel: 2,
  rateLimit: 1000,
  randomRateMin: 1000,
  randomRateMax: 1000,
  maxRetries: 3,
  backupScopes: ["metadata", "content"],
  pythonBin: "python",
  maxContentFetchPerNovel: 50,
  checkInterval: 1000,
};

/** ネットワークを使わないスクレイパー。作品ごとの話一覧と本文を差し替えられる。 */
class FakeScraper extends BaseScraper {
  listCalls: string[] = [];
  episodes = new Map<string, string[]>(); // novelKey -> episodeKeys
  bodies = new Map<string, string>(); // `${novelKey}/${episodeKey}` -> body
  updatedAt = new Map<string, string>(); // `${novelKey}/${episodeKey}` -> updatedAt
  constructor(site: SiteId) {
    super(site);
  }
  async scrapeMetadata(novelKey: string): Promise<NovelMetadata> {
    return { title: `作品${novelKey}`, author: "a", description: "", status: "", episodeCount: 0, lastUpdated: "", url: `http://x/${novelKey}` };
  }
  async scrapeEpisodeList(novelKey: string): Promise<Episode[]> {
    this.listCalls.push(novelKey);
    return (this.episodes.get(novelKey) ?? []).map((k, i) => ({
      episodeKey: k,
      position: i + 1,
      title: `第${k}話`,
      publishedAt: "2026-10-01T00:00:00Z",
      updatedAt: this.updatedAt.get(`${novelKey}/${k}`) ?? "2026-10-01T00:00:00Z",
    }));
  }
  async scrapeEpisodeContent(novelKey: string, episodeKey: string): Promise<EpisodeContent> {
    return {
      title: `第${episodeKey}話`,
      bodyHtml: this.bodies.get(`${novelKey}/${episodeKey}`) ?? `<p>${novelKey}-${episodeKey}</p>`,
      updatedAt: this.updatedAt.get(`${novelKey}/${episodeKey}`) ?? "2026-10-01T00:00:00Z",
    };
  }
}

function setup(novels: string[]) {
  const db: Db = openDb(":memory:");
  const scraper = new FakeScraper("narou");
  const scrapers = new Map<SiteId, BaseScraper>([["narou", scraper]]);
  for (const k of novels) {
    db.prepare(`INSERT INTO novels (site, novel_key, title, author, url, created_at) VALUES ('narou', ?, ?, '', '', ?)`).run(k, `作品${k}`, nowIso());
    scraper.episodes.set(k, ["1", "2"]);
  }
  const manager = new BackupManager(db, CONFIG, scrapers);
  const scheduler = new BackupScheduler(db, { ...CONFIG, frequency: "daily", time: "03:00" }, manager);
  const user = (name: string) =>
    Number(db.prepare(`INSERT INTO users (username, password_hash, role, created_at) VALUES (?, 'x', 'viewer', ?)`).run(name, nowIso()).lastInsertRowid);
  const bookmark = (userId: number, novelKey: string) => {
    const novel = db.prepare(`SELECT id FROM novels WHERE site = 'narou' AND novel_key = ?`).get(novelKey) as { id: number };
    db.prepare(`INSERT INTO bookmarks (user_id, novel_id, created_at) VALUES (?, ?, ?)`).run(userId, novel.id, nowIso());
  };

  const taskStatus = (novelKey: string) =>
    (db.prepare(`SELECT status FROM backup_tasks WHERE novel_key = ?`).get(novelKey) as { status: string } | undefined)?.status;
  return { db, scraper, manager, scheduler, user, bookmark, taskStatus };
}

describe("single-novel backup", () => {
  it("processes only the requested novel and leaves other pending tasks alone", async () => {
    const { manager, scraper, db, taskStatus } = setup(["a", "b", "c"]);
    manager.enqueueNovelBackup("narou", ["b"], 0); // 他作品の pending タスク

    expect(await manager.runNovelBackup("narou", "a")).toBe(true);

    expect(scraper.listCalls).toEqual(["a"]);
    expect(taskStatus("a")).toBe("completed");
    expect(taskStatus("b")).toBe("pending");
    expect(taskStatus("c")).toBeUndefined(); // enqueueTrackedNovels は呼ばれない
    const run = db.prepare(`SELECT status, total_tasks, completed_tasks FROM backup_run_stats`).get() as any;
    expect(run).toMatchObject({ status: "completed", total_tasks: 1, completed_tasks: 1 });
  });

  it("a full cycle still processes every tracked novel", async () => {
    const { manager, scraper } = setup(["a", "b", "c"]);
    await manager.runBackupCycle();
    expect([...scraper.listCalls].sort()).toEqual(["a", "b", "c"]);
  });

  it("scheduler.triggerNovel reports started and joins a running single-novel run", async () => {
    const { scheduler, manager, scraper, taskStatus } = setup(["a", "b"]);
    expect(scheduler.triggerNovel("narou", "a")).toBe(true);
    // 実行中に別作品を追加 → 全体サイクルは起動せず、実行中のループが b も処理する
    expect(scheduler.triggerNovel("narou", "b")).toBe(false);
    await vi.waitFor(() => expect(manager.isBusy()).toBe(false), { timeout: 5000 });
    expect([...scraper.listCalls].sort()).toEqual(["a", "b"]);
    expect(taskStatus("a")).toBe("completed");
    expect(taskStatus("b")).toBe("completed");
  });

  it("a cycle requested during a single-novel run is deferred, not lost", async () => {
    const { scheduler, manager, scraper } = setup(["a", "b"]);
    scheduler.triggerNovel("narou", "a");
    await manager.runBackupCycle(); // 実行中なので保留される
    await vi.waitFor(() => expect(scraper.listCalls.filter((k) => k === "b").length).toBe(1), { timeout: 5000 });
    await vi.waitFor(() => expect(manager.isBusy()).toBe(false), { timeout: 5000 });
  });
});
