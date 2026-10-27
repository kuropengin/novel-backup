import { describe, expect, it, vi } from "vitest";
import { TtlLru } from "../src/live/service.js";
import type { EpisodeContent, NovelInfo, SiteAdapter, SiteId } from "../src/sites/types.js";
import { SiteBlockedError, SiteNotFoundError } from "../src/sites/types.js";
import { makeAdmin, makeViewer, setupApp } from "./helpers.js";

function novelInfo(key: string): NovelInfo {
  return {
    site: "narou",
    novelKey: key,
    url: `https://ncode.syosetu.com/${key}/`,
    title: `Title ${key}`,
    author: "Author",
    synopsis: "s",
    tags: [],
    status: "ongoing",
    isShortStory: false,
    episodes: [1, 2, 3].map((n, i) => ({ episodeKey: String(n), index: i, title: `ep${n}`, chapter: "ch" })),
  };
}

function fakeAdapters() {
  const fetchNovel = vi.fn(async (key: string) => {
    if (key === "n0000zz") throw new SiteNotFoundError();
    if (key === "n9999zz") throw new SiteBlockedError("blocked", "challenge");
    return novelInfo(key);
  });
  const fetchEpisode = vi.fn(
    async (_k: string, e: string): Promise<EpisodeContent> => ({ episodeKey: e, title: `ep${e}`, bodyHtml: `<p>body${e}</p>` }),
  );
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
  return { getAdapter: (_s: SiteId) => adapter, fetchNovel, fetchEpisode };
}

describe("TtlLru", () => {
  it("expires by TTL and evicts the least recently used", () => {
    let t = 0;
    const c = new TtlLru<number>(2, 100, () => t);
    c.set("a", 1);
    c.set("b", 2);
    c.get("a");
    c.set("c", 3);
    expect(c.get("b")).toBeUndefined();
    expect(c.get("a")).toBe(1);
    t = 101;
    expect(c.get("a")).toBeUndefined();
  });
});

describe("live API", () => {
  it("requires auth", async () => {
    const { app } = setupApp({ getAdapter: fakeAdapters().getAdapter });
    const request = (await import("supertest")).default;
    expect((await request(app).get("/api/live/narou/novels/n1234ab")).status).toBe(401);
    expect((await request(app).get("/api/bookmarks")).status).toBe(401);
  });

  it("returns novel info (cached) and episode with prev/next and bookmark flag", async () => {
    const fa = fakeAdapters();
    const { app } = setupApp({ getAdapter: fa.getAdapter });
    const a = await makeAdmin(app);

    const n = await a.get("/api/live/narou/novels/n1234ab");
    expect(n.status).toBe(200);
    expect(n.body.title).toBe("Title n1234ab");
    expect(n.body.episodes).toHaveLength(3);
    expect(n.body.bookmarked).toBe(false);

    const e2 = await a.get("/api/live/narou/novels/n1234ab/episodes/2");
    expect(e2.status).toBe(200);
    expect(e2.body.bodyHtml).toBe("<p>body2</p>");
    expect(e2.body.prevEpisodeKey).toBe("1");
    expect(e2.body.nextEpisodeKey).toBe("3");
    const e1 = await a.get("/api/live/narou/novels/n1234ab/episodes/1");
    expect(e1.body.prevEpisodeKey).toBeNull();
    const e3 = await a.get("/api/live/narou/novels/n1234ab/episodes/3");
    expect(e3.body.nextEpisodeKey).toBeNull();
    // 作品取得は 1 回だけ(キャッシュ)
    expect(fa.fetchNovel).toHaveBeenCalledTimes(1);
    await a.get("/api/live/narou/novels/n1234ab/episodes/2");
    expect(fa.fetchEpisode).toHaveBeenCalledTimes(3);
  });

  it("maps site errors: not found -> 404, blocked -> 502 site_blocked", async () => {
    const { app } = setupApp({ getAdapter: fakeAdapters().getAdapter });
    const a = await makeAdmin(app);
    expect((await a.get("/api/live/narou/novels/n0000zz")).status).toBe(404);
    const b = await a.get("/api/live/narou/novels/n9999zz");
    expect(b.status).toBe(502);
    expect(b.body.error).toBe("site_blocked");
    expect(b.body.message).toBeTruthy();
    expect((await a.get("/api/live/bogus/novels/x")).status).toBe(404);
    expect((await a.get("/api/live/narou/novels/bad..key")).status).toBe(404);
  });

  it("resolve: urls, proxy paths, 404 for others, includes bookmark state", async () => {
    const { app } = setupApp({ getAdapter: fakeAdapters().getAdapter });
    const a = await makeAdmin(app);
    const r = await a.get("/api/live/resolve").query({ url: "https://ncode.syosetu.com/n1234ab/2/" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ site: "narou", novelKey: "n1234ab", episodeKey: "2", bookmarked: false });
    const p = await a.get("/api/live/resolve").query({ url: "/proxy/kakuyomu/kakuyomu.jp/works/123" });
    expect(p.body).toMatchObject({ site: "kakuyomu", novelKey: "123" });
    expect((await a.get("/api/live/resolve").query({ url: "https://example.com/n1234ab/" })).status).toBe(404);
    expect((await a.get("/api/live/resolve").query({ url: "/proxy/narou/yomou.syosetu.com/" })).status).toBe(404);
    expect((await a.get("/api/live/resolve")).status).toBe(400);
  });
});

describe("bookmarks API", () => {
  it("CRUD with per-user isolation", async () => {
    const fa = fakeAdapters();
    const { app, db } = setupApp({ getAdapter: fa.getAdapter });
    const admin = await makeAdmin(app);
    const viewer = await makeViewer(admin, app);

    const c = await admin.post("/api/bookmarks").send({ site: "narou", novelKey: "n1234ab" });
    expect(c.status).toBe(201);
    const bm = c.body.bookmark;
    expect(bm).toMatchObject({ site: "narou", novelKey: "n1234ab", title: "Title n1234ab", note: "", lastReadEpisodeKey: null });

    // 同じものを再度 POST → 200 で既存を返す
    const dup = await admin.post("/api/bookmarks").send({ url: "https://ncode.syosetu.com/n1234ab/" });
    expect(dup.status).toBe(200);
    expect(dup.body.bookmark.id).toBe(bm.id);

    // live API に bookmarked が反映される
    const n = await admin.get("/api/live/narou/novels/n1234ab");
    expect(n.body).toMatchObject({ bookmarked: true, bookmarkId: bm.id });
    const vn = await viewer.get("/api/live/narou/novels/n1234ab");
    expect(vn.body.bookmarked).toBe(false);

    // viewer からは見えない・触れない
    expect((await viewer.get("/api/bookmarks")).body.bookmarks).toHaveLength(0);
    expect((await viewer.patch(`/api/bookmarks/${bm.id}`).send({ note: "x" })).status).toBe(404);
    expect((await viewer.delete(`/api/bookmarks/${bm.id}`).send({})).status).toBe(404);

    // viewer が同じ作品をブックマーク → novels は共有される
    const vc = await viewer.post("/api/bookmarks").send({ site: "narou", novelKey: "n1234ab" });
    expect(vc.status).toBe(201);
    expect(vc.body.bookmark.id).not.toBe(bm.id);
    expect(vc.body.bookmark.novelId).toBe(bm.novelId);
    expect((db.prepare("SELECT COUNT(*) AS c FROM novels").get() as unknown as { c: number }).c).toBe(1);
    expect(fa.fetchNovel).toHaveBeenCalledTimes(1);

    // 更新
    const p = await admin.patch(`/api/bookmarks/${bm.id}`).send({ note: "メモ", lastReadEpisodeKey: "2" });
    expect(p.status).toBe(200);
    expect(p.body.bookmark).toMatchObject({ note: "メモ", lastReadEpisodeKey: "2" });
    expect((await admin.patch(`/api/bookmarks/${bm.id}`).send({ note: 5 })).status).toBe(400);
    expect((await admin.get("/api/bookmarks")).body.bookmarks[0].note).toBe("メモ");
    expect((await viewer.get("/api/bookmarks")).body.bookmarks[0].note).toBe("");

    // 削除(作品データは残る)
    expect((await admin.delete(`/api/bookmarks/${bm.id}`).send({})).status).toBe(200);
    expect((await admin.get("/api/bookmarks")).body.bookmarks).toHaveLength(0);
    expect((await admin.delete(`/api/bookmarks/${bm.id}`).send({})).status).toBe(404);
    expect((await viewer.get("/api/bookmarks")).body.bookmarks).toHaveLength(1);
    expect((db.prepare("SELECT COUNT(*) AS c FROM novels").get() as unknown as { c: number }).c).toBe(1);
  });

  it("validates input and handles unavailable sites", async () => {
    const { app } = setupApp({ getAdapter: fakeAdapters().getAdapter });
    const a = await makeAdmin(app);
    expect((await a.post("/api/bookmarks").send({})).status).toBe(400);
    expect((await a.post("/api/bookmarks").send({ site: "nope", novelKey: "x" })).status).toBe(400);
    expect((await a.post("/api/bookmarks").send({ url: "https://example.com/" })).status).toBe(400);
    expect((await a.post("/api/bookmarks").send({ site: "narou", novelKey: "n0000zz" })).status).toBe(404);
    // ブロックされていてもブックマーク自体は作れる(メタは後でバックアップが埋める)
    const b = await a.post("/api/bookmarks").send({ site: "narou", novelKey: "n9999zz" });
    expect(b.status).toBe(201);
    expect(b.body.bookmark.title).toBe("");
    expect(b.body.bookmark.url).toBe("https://ncode.syosetu.com/n9999zz/");
  });
});
