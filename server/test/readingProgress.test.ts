import { describe, expect, it } from "vitest";
import { normalizeSourceDate } from "../src/backup/dates.js";
import { BackupRepository } from "../src/backup/repository.js";
import { makeAdmin, makeViewer, setupApp } from "./helpers.js";

describe("normalizeSourceDate", () => {
  it("treats site dates as JST and returns UTC ISO", () => {
    expect(normalizeSourceDate("2026/10/03 11:00")).toBe("2026-10-03T02:00:00.000Z");
    expect(normalizeSourceDate("2026年07月11日(土) 21:51")).toBe("2026-07-11T12:51:00.000Z");
    expect(normalizeSourceDate("2026/10/11 22:10改稿")).toBe("2026-10-11T13:10:00.000Z");
    expect(normalizeSourceDate("2026-10-31T10:00:45Z")).toBe("2026-10-31T10:00:45.000Z");
    expect(normalizeSourceDate("")).toBeNull();
    expect(normalizeSourceDate("garbage")).toBeNull();
  });
});

describe("reading progress API", () => {
  it("requires auth", async () => {
    const { app } = setupApp();
    const { client } = await import("./helpers.js");
    expect((await client(app).get("/api/reading-progress/narou/n1")).status).toBe(401);
  });

  it("per-user read state and bookmark list fields", async () => {
    const { app, db } = setupApp();
    const admin = await makeAdmin(app);
    const viewer = await makeViewer(admin, app);
    await admin.post("/api/bookmarks").send({ site: "narou", novelKey: "n1", title: "T" });
    await viewer.post("/api/bookmarks").send({ site: "narou", novelKey: "n1", title: "T" });

    expect((await admin.get("/api/reading-progress/narou/n1")).body).toEqual({
      readEpisodeKeys: [],
      lastReadEpisodeKey: null,
      lastReadAt: null,
    });
    expect((await admin.put("/api/reading-progress/narou/n1/1").send({ read: true })).body).toEqual({ ok: true });
    await admin.put("/api/reading-progress/narou/n1/2").send({ read: true });
    expect((await admin.put("/api/reading-progress/narou/n1/1").send({ read: "x" })).status).toBe(400);
    expect((await admin.put("/api/reading-progress/nope/n1/1").send({ read: true })).status).toBe(400);

    const g = (await admin.get("/api/reading-progress/narou/n1")).body;
    expect(g.readEpisodeKeys.sort()).toEqual(["1", "2"]);
    expect(g.lastReadEpisodeKey).toBe("2");
    expect(typeof g.lastReadAt).toBe("string");
    expect((await viewer.get("/api/reading-progress/narou/n1")).body.readEpisodeKeys).toEqual([]);

    const item = (await admin.get("/api/bookmarks")).body.bookmarks[0];
    expect(item).toMatchObject({ readEpisodeCount: 2, lastReadEpisodeKey: "2" });
    expect((await viewer.get("/api/bookmarks")).body.bookmarks[0]).toMatchObject({ readEpisodeCount: 0, lastReadEpisodeKey: null });

    await admin.put("/api/reading-progress/narou/n1/2").send({ read: false });
    expect((await admin.get("/api/reading-progress/narou/n1")).body.readEpisodeKeys).toEqual(["1"]);
    expect(db.prepare("SELECT COUNT(*) AS c FROM reading_progress").get()).toMatchObject({ c: 1 });
  });
});

describe("source update date and author", () => {
  it("computes sourceUpdatedAt, sorts by it, and prefers real author over Unknown", async () => {
    const { app, db } = setupApp();
    const admin = await makeAdmin(app);
    const repo = new BackupRepository(db);
    const ep = (k: string, pub: string, upd: string) => ({ episodeKey: k, position: Number(k), title: k, publishedAt: pub, updatedAt: upd });

    const a = await admin.post("/api/bookmarks").send({ site: "narou", novelKey: "na", title: "A", author: "Unknown" });
    await admin.post("/api/bookmarks").send({ site: "narou", novelKey: "nb", title: "B" });
    await admin.post("/api/bookmarks").send({ site: "narou", novelKey: "nc", title: "C" });
    expect(a.body.bookmark.author).toBe("");

    repo.saveNovelMetadata("narou", "na", { title: "A", author: "Unknown", description: "", status: "", episodeCount: 0, lastUpdated: "", url: "u" });
    repo.saveNovelMetadata("narou", "na", { title: "A", author: "Real", description: "", status: "", episodeCount: 0, lastUpdated: "", url: "u" });
    // 取得失敗("Unknown")で既存の作者を上書きしない
    repo.saveNovelMetadata("narou", "na", { title: "A", author: "Unknown", description: "", status: "", episodeCount: 0, lastUpdated: "", url: "u" });
    repo.saveEpisodes("narou", "na", [ep("1", "2026/10/01 09:00", "2026/10/01 09:00"), ep("2", "2026/10/02 09:00", "2026/10/20 09:00")]);
    repo.saveEpisodes("narou", "nb", [ep("1", "2026-10-25T00:00:00Z", "")]);

    const list = (await admin.get("/api/bookmarks?sort=updated&order=desc")).body.bookmarks;
    expect(list.map((b: any) => b.novelKey)).toEqual(["nb", "na", "nc"]);
    expect(list[0].sourceUpdatedAt).toBe("2026-10-25T00:00:00.000Z");
    // 第2話の改稿日時(10/20)ではなく最新話の公開日時(10/02 09:00 JST)
    expect(list[1]).toMatchObject({ author: "Real", sourceUpdatedAt: "2026-10-02T00:00:00.000Z" });
    expect(list[2].sourceUpdatedAt).toBeNull();
    const asc = (await admin.get("/api/bookmarks?sort=updated&order=asc")).body.bookmarks;
    expect(asc.map((b: any) => b.novelKey)).toEqual(["na", "nb", "nc"]);
  });
});

describe("migration 11 backfill", () => {
  it("normalizes episode dates and fills novels.source_updated_at", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const { migrations } = await import("../src/db/migrations.js");
    const db = new DatabaseSync(":memory:");
    for (let i = 0; i < 10; i++) db.exec(migrations[i]!);
    db.exec(`INSERT INTO novels (id, site, novel_key, title, author, url, created_at) VALUES (1,'hameln','1','T - ハーメルン','Unknown','u','x')`);
    db.exec(`INSERT INTO episodes (novel_id, episode_key, position, title, site_published_at, site_updated_at, created_at) VALUES
      (1,'1',1,'a','2026/10/03 09:00','2026/10/03 09:00','x'), (1,'2',2,'b','2026/10/04 09:00','2026/10/10 11:00','x'), (1,'3',3,'c','','','x')`);
    db.exec(migrations[10]!);
    expect(db.prepare("SELECT title, author, source_updated_at AS s FROM novels").get()).toMatchObject({
      title: "T",
      author: "",
      s: "2026-10-10T02:00:00.000Z",
    });
    expect(db.prepare("SELECT site_updated_at AS u FROM episodes WHERE episode_key='3'").get()).toMatchObject({ u: null });
    // 13: 改稿日時(10/10)ではなく最新話の公開日時(10/04 09:00 JST)にする
    db.exec(migrations[12]!);
    expect(db.prepare("SELECT source_updated_at AS s FROM novels").get()).toMatchObject({ s: "2026-10-04T00:00:00.000Z" });
  });
});
