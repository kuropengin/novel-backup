import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { BackupScheduler, computeNextRun, markStaleRunsFailed, type Timers } from "../src/backup/scheduler.js";
import { backupNovel } from "../src/backup/service.js";
import { createApp } from "../src/app.js";
import { openDb } from "../src/db/index.js";
import { updateSettings } from "../src/settings.js";
import type { Db } from "../src/db/index.js";
import type { EpisodeContent, NovelInfo, SiteAdapter, SiteId, TocEntry } from "../src/sites/types.js";
import { SiteBlockedError, SiteNotFoundError } from "../src/sites/types.js";
import { makeAdmin, makeViewer, setupApp } from "./helpers.js";

/** 内容を差し替えられるフェイクアダプタ(ネットワークなし)。 */
function makeFake() {
  const state = {
    title: "Title",
    author: "Author",
    synopsis: "syn",
    episodes: [] as TocEntry[],
    bodies: new Map<string, string>(),
    novelError: null as Error | null,
    episodeError: new Map<string, Error>(),
  };
  const setEpisodes = (keys: string[], updatedAt?: (k: string) => string | undefined) => {
    state.episodes = keys.map((k, i) => ({ episodeKey: k, index: i, title: `ep${k}`, chapter: "ch", updatedAt: updatedAt?.(k) }));
    for (const k of keys) if (!state.bodies.has(k)) state.bodies.set(k, `<p>body${k}</p>`);
  };
  const fetchNovel = vi.fn(async (key: string): Promise<NovelInfo> => {
    if (state.novelError) throw state.novelError;
    return {
      site: "narou",
      novelKey: key,
      url: `https://ncode.syosetu.com/${key}/`,
      title: state.title,
      author: state.author,
      synopsis: state.synopsis,
      tags: [],
      status: "ongoing",
      isShortStory: false,
      episodes: state.episodes,
    };
  });
  const fetchEpisode = vi.fn(async (_k: string, e: string): Promise<EpisodeContent> => {
    const err = state.episodeError.get(e);
    if (err) throw err;
    return { episodeKey: e, title: `ep${e}`, bodyHtml: state.bodies.get(e) ?? "" };
  });
  const adapter: SiteAdapter = {
    site: "narou",
    displayName: "なろう",
    hosts: ["ncode.syosetu.com"],
    parseUrl: () => null,
    novelUrl: (k) => `https://ncode.syosetu.com/${k}/`,
    episodeUrl: (k, e) => `https://ncode.syosetu.com/${k}/${e}/`,
    fetchNovel,
    fetchEpisode,
  };
  return { state, setEpisodes, fetchNovel, fetchEpisode, getAdapter: (_s: SiteId) => adapter };
}

function addNovel(db: Db, key = "n0001aa", title = ""): number {
  const r = db
    .prepare("INSERT INTO novels (site, novel_key, title, author, url, created_at) VALUES ('narou', ?, ?, '', ?, ?)")
    .run(key, title, `https://ncode.syosetu.com/${key}/`, new Date().toISOString());
  return Number(r.lastInsertRowid);
}
const quiet = { log: () => undefined };
const one = <T>(db: Db, sql: string, ...args: (string | number)[]) => db.prepare(sql).get(...args) as unknown as T;
const versions = (db: Db, novelId: number, key: string) =>
  one<{ c: number }>(
    db,
    "SELECT COUNT(*) AS c FROM episode_versions v JOIN episodes e ON e.id = v.episode_id WHERE e.novel_id = ? AND e.episode_key = ?",
    novelId,
    key,
  ).c;

describe("backupNovel", () => {
  it("creates v1 on first fetch, fills the empty title, and adds nothing when unchanged", async () => {
    const { db } = setupApp();
    const f = makeFake();
    f.setEpisodes(["1", "2"]);
    const id = addNovel(db);

    const r1 = await backupNovel(db, f.getAdapter, id, quiet);
    expect(r1.status).toBe("ok");
    expect(r1.episodesFetched).toBe(2);
    expect(versions(db, id, "1")).toBe(1);
    expect(versions(db, id, "2")).toBe(1);
    const n = one<{ title: string; author: string; last_checked_at: string; last_changed_at: string; last_error: string | null }>(
      db,
      "SELECT * FROM novels WHERE id = ?",
      id,
    );
    expect(n.title).toBe("Title");
    expect(n.author).toBe("Author");
    expect(n.last_checked_at).toBeTruthy();
    expect(n.last_changed_at).toBeTruthy();
    expect(n.last_error).toBeNull();
    expect(one<{ c: number }>(db, "SELECT COUNT(*) AS c FROM novel_meta_versions WHERE novel_id = ?", id).c).toBe(1);

    // 変更なし: 本文は再取得されず、版も増えない
    f.fetchEpisode.mockClear();
    const r2 = await backupNovel(db, f.getAdapter, id, quiet);
    expect(r2.episodesFetched).toBe(0);
    expect(r2.versionsAdded).toBe(0);
    expect(f.fetchEpisode).not.toHaveBeenCalled();
    expect(versions(db, id, "1")).toBe(1);
    expect(one<{ c: number }>(db, "SELECT COUNT(*) AS c FROM novel_meta_versions WHERE novel_id = ?", id).c).toBe(1);

    // force: 全話再取得するがハッシュ同一なら版は増えない
    const r3 = await backupNovel(db, f.getAdapter, id, { ...quiet, force: true });
    expect(r3.episodesFetched).toBe(2);
    expect(r3.versionsAdded).toBe(0);
  });

  it("adds v2 when the body changes (updatedAt differs)", async () => {
    const { db } = setupApp();
    const f = makeFake();
    f.setEpisodes(["1"], () => "2026-01-01T00:00:00.000Z");
    const id = addNovel(db);
    await backupNovel(db, f.getAdapter, id, quiet);

    f.state.bodies.set("1", "<p>changed</p>");
    f.setEpisodes(["1"], () => "2026-02-01T00:00:00.000Z");
    const r = await backupNovel(db, f.getAdapter, id, quiet);
    expect(r.versionsAdded).toBe(2); // メタ版(目次の更新日時)+ 話の v2
    expect(versions(db, id, "1")).toBe(2);
    const latest = one<{ version: number; body_html: string; site_updated_at: string }>(
      db,
      "SELECT v.* FROM episode_versions v JOIN episodes e ON e.id = v.episode_id WHERE e.novel_id = ? ORDER BY v.version DESC LIMIT 1",
      id,
    );
    expect(latest.version).toBe(2);
    expect(latest.body_html).toBe("<p>changed</p>");
    expect(latest.site_updated_at).toBe("2026-02-01T00:00:00.000Z");
    // 旧版も残っている
    expect(one<{ body_html: string }>(db, "SELECT body_html FROM episode_versions WHERE version = 1 AND episode_id = (SELECT id FROM episodes WHERE novel_id = ?)", id).body_html).toBe(
      "<p>body1</p>",
    );
  });

  it("does not re-fetch forever when only updatedAt changes but the body is identical", async () => {
    const { db } = setupApp();
    const f = makeFake();
    f.setEpisodes(["1"], () => "2026-01-01T00:00:00.000Z");
    const id = addNovel(db);
    await backupNovel(db, f.getAdapter, id, quiet);
    f.setEpisodes(["1"], () => "2026-02-01T00:00:00.000Z");
    const r = await backupNovel(db, f.getAdapter, id, quiet);
    expect(r.episodesFetched).toBe(1);
    expect(r.versionsAdded).toBe(1); // メタ版のみ。話の版は増えない
    expect(versions(db, id, "1")).toBe(1);
    f.fetchEpisode.mockClear();
    await backupNovel(db, f.getAdapter, id, quiet);
    expect(f.fetchEpisode).not.toHaveBeenCalled();
  });

  it("catches edits without revision dates only via full recheck (kakuyomu style)", async () => {
    const { db } = setupApp();
    const f = makeFake();
    f.setEpisodes(["1"]); // updatedAt 無し
    const id = addNovel(db);
    await backupNovel(db, f.getAdapter, id, quiet);
    f.state.bodies.set("1", "<p>edited silently</p>");
    expect((await backupNovel(db, f.getAdapter, id, quiet)).versionsAdded).toBe(0);
    const r = await backupNovel(db, f.getAdapter, id, { ...quiet, force: true });
    expect(r.versionsAdded).toBe(1);
    expect(versions(db, id, "1")).toBe(2);
  });

  it("sets removed_at when an episode disappears from the TOC and clears it when it returns", async () => {
    const { db } = setupApp();
    const f = makeFake();
    f.setEpisodes(["1", "2", "3"]);
    const id = addNovel(db);
    await backupNovel(db, f.getAdapter, id, quiet);

    f.setEpisodes(["1", "3"]);
    await backupNovel(db, f.getAdapter, id, quiet);
    const removed = one<{ removed_at: string | null }>(db, "SELECT removed_at FROM episodes WHERE novel_id = ? AND episode_key = '2'", id);
    expect(removed.removed_at).toBeTruthy();
    expect(versions(db, id, "2")).toBe(1); // データは残る
    expect(one<{ removed_at: string | null }>(db, "SELECT removed_at FROM episodes WHERE novel_id = ? AND episode_key = '1'", id).removed_at).toBeNull();

    f.setEpisodes(["1", "2", "3"]);
    await backupNovel(db, f.getAdapter, id, quiet);
    expect(one<{ removed_at: string | null }>(db, "SELECT removed_at FROM episodes WHERE novel_id = ? AND episode_key = '2'", id).removed_at).toBeNull();
    // 目次(メタ版)の変化も履歴になる
    expect(one<{ c: number }>(db, "SELECT COUNT(*) AS c FROM novel_meta_versions WHERE novel_id = ?", id).c).toBe(3);
  });

  it("does not wipe episodes when the TOC comes back empty", async () => {
    const { db } = setupApp();
    const f = makeFake();
    f.setEpisodes(["1", "2"]);
    const id = addNovel(db);
    await backupNovel(db, f.getAdapter, id, quiet);
    f.setEpisodes([]);
    const r = await backupNovel(db, f.getAdapter, id, quiet);
    expect(r.status).toBe("failed");
    expect(one<{ c: number }>(db, "SELECT COUNT(*) AS c FROM episodes WHERE novel_id = ? AND removed_at IS NOT NULL", id).c).toBe(0);
  });

  it("marks is_deleted_on_site on SiteNotFoundError (data kept) and clears it on recovery", async () => {
    const { db } = setupApp();
    const f = makeFake();
    f.setEpisodes(["1"]);
    const id = addNovel(db);
    await backupNovel(db, f.getAdapter, id, quiet);

    f.state.novelError = new SiteNotFoundError();
    const r = await backupNovel(db, f.getAdapter, id, quiet);
    expect(r.status).toBe("failed");
    expect(r.deletedOnSite).toBe(true);
    const n = one<{ is_deleted_on_site: number; last_error: string }>(db, "SELECT * FROM novels WHERE id = ?", id);
    expect(n.is_deleted_on_site).toBe(1);
    expect(n.last_error).toBeTruthy();
    expect(versions(db, id, "1")).toBe(1);

    f.state.novelError = null;
    await backupNovel(db, f.getAdapter, id, quiet);
    expect(one<{ is_deleted_on_site: number; last_error: string | null }>(db, "SELECT * FROM novels WHERE id = ?", id)).toMatchObject({
      is_deleted_on_site: 0,
      last_error: null,
    });
  });

  it("records SiteBlockedError as last_error without marking the novel deleted", async () => {
    const { db } = setupApp();
    const f = makeFake();
    f.state.novelError = new SiteBlockedError("cf", "challenge");
    const id = addNovel(db);
    const r = await backupNovel(db, f.getAdapter, id, quiet);
    expect(r.status).toBe("failed");
    expect(r.deletedOnSite).toBe(false);
    const n = one<{ is_deleted_on_site: number; last_error: string }>(db, "SELECT * FROM novels WHERE id = ?", id);
    expect(n.is_deleted_on_site).toBe(0);
    expect(n.last_error).toContain("ブロック");
  });

  it("continues after a single episode failure and records the error; blocked episode aborts", async () => {
    const { db } = setupApp();
    const f = makeFake();
    f.setEpisodes(["1", "2", "3"]);
    f.state.episodeError.set("2", new Error("boom"));
    const id = addNovel(db);
    const r = await backupNovel(db, f.getAdapter, id, quiet);
    expect(r.status).toBe("partial");
    expect(r.episodesFetched).toBe(2);
    expect(versions(db, id, "3")).toBe(1);
    expect(r.errors[0]).toContain("boom");
    expect(one<{ last_error: string }>(db, "SELECT last_error FROM novels WHERE id = ?", id).last_error).toContain("boom");
    // 失敗した話は次回再取得される
    f.state.episodeError.clear();
    const r2 = await backupNovel(db, f.getAdapter, id, quiet);
    expect(r2.episodesFetched).toBe(1);
    expect(versions(db, id, "2")).toBe(1);
  });

  it("respects maxEpisodesPerNovelPerRun and resumes in later runs", async () => {
    const { db } = setupApp();
    const f = makeFake();
    f.setEpisodes(["1", "2", "3", "4", "5"]);
    updateSettings(db, { maxEpisodesPerNovelPerRun: 2 });
    const id = addNovel(db);
    expect((await backupNovel(db, f.getAdapter, id, quiet)).episodesFetched).toBe(2);
    expect((await backupNovel(db, f.getAdapter, id, quiet)).episodesFetched).toBe(2);
    expect((await backupNovel(db, f.getAdapter, id, quiet)).episodesFetched).toBe(1);
    expect((await backupNovel(db, f.getAdapter, id, quiet)).episodesFetched).toBe(0);
    expect(one<{ c: number }>(db, "SELECT COUNT(*) AS c FROM episode_versions").c).toBe(5);
  });
});

describe("computeNextRun", () => {
  it("returns null when disabled", () => {
    expect(computeNextRun({ backupIntervalMinutes: 0, backupStartAt: null }, new Date(), null)).toBeNull();
  });
  it("uses last finish + interval when no start time", () => {
    const now = new Date("2026-01-01T10:00:00");
    const last = new Date("2026-01-01T08:00:00");
    expect(computeNextRun({ backupIntervalMinutes: 360, backupStartAt: null }, now, last)).toEqual(new Date("2026-01-01T14:00:00"));
    // 過ぎていれば now
    expect(computeNextRun({ backupIntervalMinutes: 30, backupStartAt: null }, now, last)).toEqual(now);
    // 履歴なし: now + interval
    expect(computeNextRun({ backupIntervalMinutes: 60, backupStartAt: null }, now, null)).toEqual(new Date("2026-01-01T11:00:00"));
  });
  it("aligns to startAt slots (03:00 + 360 → 3,9,15,21)", () => {
    const s = { backupIntervalMinutes: 360, backupStartAt: "03:00" };
    expect(computeNextRun(s, new Date("2026-01-01T10:00:00"), null)).toEqual(new Date("2026-01-01T15:00:00"));
    expect(computeNextRun(s, new Date("2026-01-01T02:00:00"), null)).toEqual(new Date("2026-01-01T03:00:00"));
    expect(computeNextRun(s, new Date("2026-01-01T03:00:00"), null)).toEqual(new Date("2026-01-01T09:00:00"));
    expect(computeNextRun(s, new Date("2026-01-01T22:00:00"), null)).toEqual(new Date("2026-01-02T03:00:00"));
  });
});

function fakeTimers() {
  const t = { fn: null as (() => void) | null, ms: -1, cleared: 0 };
  const timers: Timers = {
    set: (fn, ms) => {
      t.fn = fn;
      t.ms = ms;
      return t;
    },
    clear: () => {
      t.fn = null;
      t.cleared++;
    },
  };
  return { t, timers };
}

describe("BackupScheduler", () => {
  function setup() {
    const { db } = setupApp();
    const f = makeFake();
    f.setEpisodes(["1"]);
    const clock = { now: new Date("2026-01-01T10:00:00") };
    const { t, timers } = fakeTimers();
    const sch = new BackupScheduler({ db, getAdapter: f.getAdapter, now: () => clock.now, timers, log: () => undefined });
    return { db, f, clock, t, sch };
  }
  const bookmark = (db: Db, novelId: number, userId = 1) => {
    db.prepare("INSERT OR IGNORE INTO users (id, username, password_hash, role, created_at) VALUES (1, 'u', 'x', 'admin', 'now')").run();
    db.prepare("INSERT INTO bookmarks (user_id, novel_id, created_at) VALUES (?, ?, 'now')").run(userId, novelId);
  };

  it("schedules by interval, runs on fire, and reschedules afterwards", async () => {
    const { db, f, clock, t, sch } = setup();
    updateSettings(db, { backupIntervalMinutes: 60 });
    bookmark(db, addNovel(db));
    sch.start();
    expect(t.ms).toBe(60 * 60_000);
    expect(sch.status().nextRunAt).toBe(new Date("2026-01-01T11:00:00").toISOString());

    // 時刻前の発火は実行せず再予約
    expect(await sch.fire()).toEqual({ started: false, reason: "not_due" });
    expect(f.fetchNovel).not.toHaveBeenCalled();

    clock.now = new Date("2026-01-01T11:00:00");
    const r = await sch.fire();
    expect(r.started).toBe(true);
    expect(sch.status().runningAll).toBe(true);
    expect(sch.status().nextRunAt).toBeNull();
    await sch.idle();
    expect(f.fetchNovel).toHaveBeenCalledTimes(1);
    const run = one<{ trigger: string; status: string; versions_added: number }>(db, "SELECT * FROM backup_runs ORDER BY id DESC LIMIT 1");
    expect(run).toMatchObject({ trigger: "schedule", status: "success" });
    expect(run.versions_added).toBe(2); // メタ + 1 話
    // 終了後は終了時刻 + interval で再予約
    expect(sch.status().nextRunAt).toBe(new Date("2026-01-01T12:00:00").toISOString());
    sch.stop();
  });

  it("re-reads settings on change and disables with 0", () => {
    const { db, t, sch } = setup();
    sch.start();
    expect(sch.status().nextRunAt).not.toBeNull(); // 既定 360 分
    updateSettings(db, { backupIntervalMinutes: 0 });
    expect(sch.status().nextRunAt).toBeNull();
    expect(t.fn).toBeNull();
    updateSettings(db, { backupIntervalMinutes: 30, backupStartAt: "03:00" });
    expect(sch.status().nextRunAt).toBe(new Date("2026-01-01T10:30:00").toISOString());
    sch.stop();
  });

  it("never double-runs: a second runAll / fire while running is refused", async () => {
    const { db, f, sch } = setup();
    bookmark(db, addNovel(db));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    f.fetchNovel.mockImplementationOnce(async (key: string) => {
      await gate;
      return {
        site: "narou", novelKey: key, url: "u", title: "T", author: "A", synopsis: "", tags: [], status: "ongoing", isShortStory: false,
        episodes: f.state.episodes,
      } as NovelInfo;
    });
    const a = sch.runAll({ trigger: "manual" });
    const b = sch.runAll({ trigger: "manual" });
    expect(a.started).toBe(true);
    expect(b).toEqual({ started: false, reason: "running" });
    expect((await sch.fire()).started).toBe(false);
    release();
    await sch.idle();
    expect(one<{ c: number }>(db, "SELECT COUNT(*) AS c FROM backup_runs").c).toBe(1);
    expect(f.fetchNovel).toHaveBeenCalledTimes(1);
    // 終わったら再度実行できる
    expect(sch.runAll({ trigger: "manual" }).started).toBe(true);
    await sch.idle();
  });

  it("ignores duplicate enqueue of the same novel and processes the queue serially", async () => {
    const { db, f, sch } = setup();
    const id = addNovel(db);
    expect(sch.enqueue(id, "bookmark")).toBe("queued");
    expect(sch.enqueue(id, "bookmark")).toBe("duplicate");
    expect(sch.enqueue(9999, "bookmark")).toBe("missing");
    await sch.idle();
    expect(f.fetchNovel).toHaveBeenCalledTimes(1);
    const run = one<{ trigger: string; status: string }>(db, "SELECT * FROM backup_runs");
    expect(run).toMatchObject({ trigger: "bookmark", status: "success" });
    // 完了後は再投入できる
    expect(sch.enqueue(id, "novel")).toBe("queued");
    await sch.idle();
    expect(f.fetchNovel).toHaveBeenCalledTimes(2);
  });

  it("does not double-add versions when runAll and enqueue hit the same novel concurrently", async () => {
    const { db, sch } = setup();
    const id = addNovel(db);
    bookmark(db, id);
    sch.runAll({ trigger: "manual" });
    sch.enqueue(id, "novel");
    await sch.idle();
    expect(versions(db, id, "1")).toBe(1);
  });

  it("runs a full recheck every N scheduled runs (fullRecheckEveryRuns)", async () => {
    const { db, f, sch } = setup();
    const id = addNovel(db);
    bookmark(db, id);
    updateSettings(db, { fullRecheckEveryRuns: 2 });
    sch.runAll({ trigger: "schedule" }); // 1 回目: 初回取得
    await sch.idle();
    f.state.bodies.set("1", "<p>silent edit</p>");
    sch.runAll({ trigger: "schedule" }); // 2 回目: 全話再取得
    await sch.idle();
    expect(versions(db, id, "1")).toBe(2);
    f.state.bodies.set("1", "<p>silent edit 2</p>");
    sch.runAll({ trigger: "schedule" }); // 3 回目: 通常
    await sch.idle();
    expect(versions(db, id, "1")).toBe(2);
  });

  it("records partial/failed run status with errors, and failed novels do not become deleted when blocked", async () => {
    const { db, f, sch } = setup();
    const id = addNovel(db);
    bookmark(db, id);
    f.state.novelError = new SiteBlockedError("cf", "challenge");
    sch.runAll({ trigger: "manual" });
    await sch.idle();
    const run = one<{ status: string; errors_json: string }>(db, "SELECT * FROM backup_runs");
    expect(run.status).toBe("failed");
    expect(JSON.parse(run.errors_json)[0]).toMatchObject({ novelId: id });
    expect(one<{ is_deleted_on_site: number }>(db, "SELECT is_deleted_on_site FROM novels WHERE id = ?", id).is_deleted_on_site).toBe(0);
  });

  it("marks leftover running runs as failed on startup", () => {
    const { db } = setupApp();
    db.prepare("INSERT INTO backup_runs (trigger, started_at, status) VALUES ('schedule', 'x', 'running')").run();
    expect(markStaleRunsFailed(db)).toBe(1);
    expect(one<{ status: string; finished_at: string }>(db, "SELECT * FROM backup_runs")).toMatchObject({ status: "failed" });
  });
});

describe("backups API", () => {
  async function build() {
    const f = makeFake();
    f.setEpisodes(["1", "2"]);
    const db = openDb(":memory:");
    const scheduler = new BackupScheduler({ db, getAdapter: f.getAdapter, log: () => undefined });
    const app = createApp({ db, getAdapter: f.getAdapter, scheduler });
    const admin = await makeAdmin(app);
    const viewer = await makeViewer(admin, app, "viewer1");
    const viewer2 = await makeViewer(admin, app, "viewer2");
    return { f, db, app, scheduler, admin, viewer, viewer2 };
  }

  it("requires auth, and admin-only endpoints reject viewers", async () => {
    const { app, viewer } = await build();
    expect((await request(app).get("/api/backups/novels")).status).toBe(401);
    expect((await viewer.get("/api/backups/runs")).status).toBe(403);
    expect((await viewer.post("/api/backups/run").send({})).status).toBe(403);
    expect((await viewer.delete("/api/backups/novels/1").send({})).status).toBe(403);
    expect((await viewer.get("/api/backups/status")).status).toBe(200);
  });

  it("enforces the viewer rule: only novels they bookmark; admin sees all", async () => {
    const { app, db, scheduler, admin, viewer, viewer2, f } = await build();
    const id = addNovel(db, "n0001aa", "T");
    const other = addNovel(db, "n0002bb", "Other");
    db.prepare("INSERT INTO bookmarks (user_id, novel_id, created_at) VALUES (2, ?, 'now')").run(id); // viewer1
    await backupNovel(db, f.getAdapter, id, quiet);
    await backupNovel(db, f.getAdapter, other, quiet);

    const list = await viewer.get("/api/backups/novels");
    expect(list.status).toBe(200);
    expect(list.body.novels.map((n: { id: number }) => n.id)).toEqual([id]);
    expect((await viewer2.get("/api/backups/novels")).body.novels).toEqual([]);
    expect((await admin.get("/api/backups/novels")).body.novels).toHaveLength(2);

    expect((await viewer.get(`/api/backups/novels/${id}`)).status).toBe(200);
    expect((await viewer.get(`/api/backups/novels/${other}`)).status).toBe(404);
    expect((await viewer2.get(`/api/backups/novels/${id}`)).status).toBe(404);
    expect((await viewer2.post(`/api/backups/novels/${id}/run`).send({})).status).toBe(404);
    expect((await viewer.post(`/api/backups/novels/${other}/run`).send({})).status).toBe(404);
    expect((await viewer2.get(`/api/backups/novels/${id}/export`)).status).toBe(404);
    const epId = one<{ id: number }>(db, "SELECT id FROM episodes WHERE novel_id = ? LIMIT 1", id).id;
    expect((await viewer2.get(`/api/backups/novels/${id}/episodes/${epId}`)).status).toBe(404);
    expect((await viewer.get(`/api/backups/novels/${id}/episodes/${epId}`)).status).toBe(200);
    // 別作品の話を自作品 ID 経由で取得できない
    const otherEp = one<{ id: number }>(db, "SELECT id FROM episodes WHERE novel_id = ? LIMIT 1", other).id;
    expect((await viewer.get(`/api/backups/novels/${id}/episodes/${otherEp}`)).status).toBe(404);

    // ブックマーク解除後は見えなくなる(admin は見える)
    db.prepare("DELETE FROM bookmarks").run();
    expect((await viewer.get(`/api/backups/novels/${id}`)).status).toBe(404);
    expect((await admin.get(`/api/backups/novels/${id}`)).status).toBe(200);
    void scheduler;
  });

  it("serves novel detail, latest episode, specific versions, and queues a run", async () => {
    const { app, db, scheduler, admin, f } = await build();
    void app;
    const id = addNovel(db, "n0001aa");
    db.prepare("INSERT INTO bookmarks (user_id, novel_id, created_at) VALUES (1, ?, 'now')").run(id);

    const run = await admin.post(`/api/backups/novels/${id}/run`).send({});
    expect(run.status).toBe(202);
    expect(run.body.queued).toBe(true);
    await scheduler.idle();

    f.state.bodies.set("1", "<p>v2 body</p>");
    f.setEpisodes(["1", "2"], () => "2026-03-01T00:00:00.000Z");
    expect((await admin.post(`/api/backups/novels/${id}/run`).send({})).status).toBe(202);
    await scheduler.idle();

    const detail = (await admin.get(`/api/backups/novels/${id}`)).body;
    expect(detail.novel.title).toBe("Title");
    expect(detail.novel.versionCount).toBe(3);
    expect(detail.metaVersions.length).toBe(2); // 目次の updatedAt が変わった
    expect(detail.episodes).toHaveLength(2);
    expect(detail.episodes[0]).toMatchObject({ episodeKey: "1", versionCount: 2, removedAt: null });

    const epId = detail.episodes[0].id;
    const latest = (await admin.get(`/api/backups/novels/${id}/episodes/${epId}`)).body;
    expect(latest.version.version).toBe(2);
    expect(latest.version.bodyHtml).toBe("<p>v2 body</p>");
    expect(latest.versions.map((v: { version: number }) => v.version)).toEqual([1, 2]);
    expect(latest.episode.nextEpisodeId).toBe(detail.episodes[1].id);
    const v1 = (await admin.get(`/api/backups/novels/${id}/episodes/${epId}/versions/1`)).body;
    expect(v1.version.bodyHtml).toBe("<p>body1</p>");
    expect((await admin.get(`/api/backups/novels/${id}/episodes/${epId}/versions/9`)).status).toBe(404);

    const txt = await admin.get(`/api/backups/novels/${id}/export?format=txt`);
    expect(txt.status).toBe(200);
    expect(txt.text).toContain("v2 body");
    expect((await admin.get(`/api/backups/novels/${id}/export?format=html`)).text).toContain("<!doctype html>");
    expect((await admin.get(`/api/backups/novels/${id}/export?format=pdf`)).status).toBe(400);
  });

  it("admin run-all: 202, then 409 while running; runs list and status", async () => {
    const { db, scheduler, admin, f } = await build();
    const id = addNovel(db);
    db.prepare("INSERT INTO bookmarks (user_id, novel_id, created_at) VALUES (1, ?, 'now')").run(id);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    f.fetchNovel.mockImplementationOnce(async (key: string) => {
      await gate;
      return { site: "narou", novelKey: key, url: "u", title: "T", author: "A", synopsis: "", tags: [], status: "ongoing", isShortStory: false, episodes: f.state.episodes } as NovelInfo;
    });
    const r1 = await admin.post("/api/backups/run").send({ force: true });
    expect(r1.status).toBe(202);
    const r2 = await admin.post("/api/backups/run").send({});
    expect(r2.status).toBe(409);
    expect((await admin.get("/api/backups/status")).body).toMatchObject({ running: true, runningAll: true });
    release();
    await scheduler.idle();
    const runs = (await admin.get("/api/backups/runs")).body.runs;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ trigger: "manual", status: "success", novelsChecked: 1 });
    expect((await admin.get("/api/backups/status")).body.running).toBe(false);
  });

  it("admin can delete a novel with all versions", async () => {
    const { db, admin, f } = await build();
    const id = addNovel(db);
    await backupNovel(db, f.getAdapter, id, quiet);
    expect((await admin.delete(`/api/backups/novels/${id}`).send({})).status).toBe(200);
    expect(one<{ c: number }>(db, "SELECT COUNT(*) AS c FROM episode_versions").c).toBe(0);
    expect((await admin.get(`/api/backups/novels/${id}`)).status).toBe(404);
  });
});
