import { describe, expect, it } from "vitest";
import { client, makeAdmin, makeViewer, setupApp } from "./helpers.js";

describe("bookmarks API", () => {
  it("requires auth", async () => {
    const { app } = setupApp();
    expect((await client(app).get("/api/bookmarks")).status).toBe(401);
    expect((await client(app, "nope").post("/api/bookmarks").send({ url: "x", title: "t" })).status).toBe(401);
  });

  it("CRUD with per-user isolation; no site access", async () => {
    const { app, db } = setupApp();
    const admin = await makeAdmin(app);
    const viewer = await makeViewer(admin, app);

    // 話ページの URL でも作品に解決される
    const c = await admin.post("/api/bookmarks").send({ url: "https://ncode.syosetu.com/n1234ab/5/", title: "My Novel", author: "Me" });
    expect(c.status).toBe(201);
    expect(c.body.created).toBe(true);
    const bm = c.body.bookmark;
    expect(bm).toEqual({
      id: bm.id,
      novelId: bm.novelId,
      site: "narou",
      novelKey: "n1234ab",
      title: "My Novel",
      author: "Me",
      url: "https://ncode.syosetu.com/n1234ab/",
      note: "",
      lastReadEpisodeKey: null,
      lastReadAt: null,
      readEpisodeCount: 0,
      sourceUpdatedAt: null,
      createdAt: bm.createdAt,
      lastBackupMetadataAt: null,
      lastBackupAllAt: null,
      backupEpisodeCount: 0,
    });

    // site + novelKey 指定、author は任意
    const k = await admin.post("/api/bookmarks").send({ site: "kakuyomu", novelKey: "123", title: "K" });
    expect(k.status).toBe(201);
    expect(k.body.bookmark).toMatchObject({ url: "https://kakuyomu.jp/works/123", author: "" });

    // 重複は 200 / created:false。既存タイトルは上書きしない
    const dup = await admin.post("/api/bookmarks").send({ url: "https://ncode.syosetu.com/n1234ab/", title: "Other" });
    expect(dup.status).toBe(200);
    expect(dup.body.created).toBe(false);
    expect(dup.body.bookmark).toMatchObject({ id: bm.id, title: "My Novel" });

    // viewer からは見えない・触れない
    expect((await viewer.get("/api/bookmarks")).body.bookmarks).toHaveLength(0);
    expect((await viewer.patch(`/api/bookmarks/${bm.id}`).send({ note: "x" })).status).toBe(404);
    expect((await viewer.delete(`/api/bookmarks/${bm.id}`)).status).toBe(404);

    // viewer が同じ作品をブックマーク → novels は共有
    const vc = await viewer.post("/api/bookmarks").send({ site: "narou", novelKey: "n1234ab", title: "x" });
    expect(vc.status).toBe(201);
    expect(vc.body.bookmark.novelId).toBe(bm.novelId);
    expect((db.prepare("SELECT COUNT(*) AS c FROM novels").get() as unknown as { c: number }).c).toBe(2);

    // 更新
    const p = await admin.patch(`/api/bookmarks/${bm.id}`).send({ note: "メモ", lastReadEpisodeKey: "2", title: "New" });
    expect(p.status).toBe(200);
    expect(p.body.bookmark).toMatchObject({ note: "メモ", lastReadEpisodeKey: "2", title: "New" });
    expect((await admin.patch(`/api/bookmarks/${bm.id}`).send({ title: "" })).status).toBe(400);
    expect((await admin.patch(`/api/bookmarks/${bm.id}`).send({ note: 5 })).status).toBe(400);
    expect((await admin.get("/api/bookmarks")).body.bookmarks.map((b: { id: number }) => b.id)).toEqual([k.body.bookmark.id, bm.id]);

    // 削除(作品データは残る)
    expect((await admin.delete(`/api/bookmarks/${bm.id}`)).status).toBe(200);
    expect((await admin.delete(`/api/bookmarks/${bm.id}`)).status).toBe(404);
    expect((await viewer.get("/api/bookmarks")).body.bookmarks).toHaveLength(1);
  });

  it("validates input", async () => {
    const { app } = setupApp();
    const a = await makeAdmin(app);
    expect((await a.post("/api/bookmarks").send({})).status).toBe(400);
    // title は必須
    expect((await a.post("/api/bookmarks").send({ url: "https://ncode.syosetu.com/n1234ab/" })).status).toBe(400);
    expect((await a.post("/api/bookmarks").send({ site: "narou", novelKey: "n1234ab" })).status).toBe(400);
    expect((await a.post("/api/bookmarks").send({ site: "nope", novelKey: "x", title: "t" })).status).toBe(400);
    for (const url of ["https://yomou.syosetu.com/", "https://example.com/n1234ab/", "https://kakuyomu.jp/"]) {
      const r = await a.post("/api/bookmarks").send({ url, title: "X" });
      expect(r.status).toBe(400);
      expect(r.body.error).toBe("not_a_novel_page");
    }
  });
});

describe("bookmarks list query and lookup", () => {
  async function seed() {
    const { app } = setupApp();
    const a = await makeAdmin(app);
    const v = await makeViewer(a, app);
    const add = async (c: typeof a, body: object) => (await c.post("/api/bookmarks").send(body)).body.bookmark;
    const b1 = await add(a, { url: "https://ncode.syosetu.com/n1111aa/", title: "banana", author: "Zed" });
    await add(a, { url: "https://kakuyomu.jp/works/22", title: "Apple", author: "Amy" });
    await add(a, { url: "https://syosetu.org/novel/33/", title: "cherry 100%", author: "Bob" });
    await add(v, { url: "https://ncode.syosetu.com/n9999zz/", title: "banana other" });
    return { app, a, v, b1 };
  }
  const titles = (r: { body: { bookmarks: { title: string }[] } }) => r.body.bookmarks.map((b) => b.title);

  it("sorts and filters, per user", async () => {
    const { a, v } = await seed();
    expect(titles(await a.get("/api/bookmarks"))).toEqual(["cherry 100%", "Apple", "banana"]);
    expect(titles(await a.get("/api/bookmarks?sort=added&order=asc"))).toEqual(["banana", "Apple", "cherry 100%"]);
    expect(titles(await a.get("/api/bookmarks?sort=updated"))).toEqual(["cherry 100%", "Apple", "banana"]);
    expect(titles(await a.get("/api/bookmarks?sort=title&order=asc"))).toEqual(["Apple", "banana", "cherry 100%"]);
    expect(titles(await a.get("/api/bookmarks?sort=title&order=desc"))).toEqual(["cherry 100%", "banana", "Apple"]);
    expect(titles(await a.get("/api/bookmarks?sort=site&order=asc"))).toEqual(["cherry 100%", "Apple", "banana"]); // hameln, kakuyomu, narou
    expect(titles(await a.get("/api/bookmarks?q=ANA"))).toEqual(["banana"]);
    expect(titles(await a.get("/api/bookmarks?q=amy"))).toEqual(["Apple"]);
    expect(titles(await a.get("/api/bookmarks?q=kakuyomu"))).toEqual(["Apple"]);
    expect(titles(await a.get("/api/bookmarks?q=" + encodeURIComponent("ハーメルン")))).toEqual(["cherry 100%"]);
    expect(titles(await a.get("/api/bookmarks?q=%25"))).toEqual(["cherry 100%"]); // 文字としての %
    expect(titles(await a.get("/api/bookmarks?q=nomatch"))).toEqual([]);
    expect(titles(await v.get("/api/bookmarks?q=banana"))).toEqual(["banana other"]);
    expect((await a.get("/api/bookmarks?sort=bogus")).status).toBe(400);
    expect((await a.get("/api/bookmarks?order=up")).status).toBe(400);
  });

  it("lookup resolves episode URLs to the novel bookmark, per user", async () => {
    const { app, a, v, b1 } = await seed();
    const hit = await a.get("/api/bookmarks/lookup?url=" + encodeURIComponent("https://ncode.syosetu.com/n1111aa/5/"));
    expect(hit.status).toBe(200);
    expect(hit.body).toEqual({ bookmarked: true, bookmarkId: b1.id });
    const other = await v.get("/api/bookmarks/lookup?url=" + encodeURIComponent("https://ncode.syosetu.com/n1111aa/"));
    expect(other.body).toEqual({ bookmarked: false, bookmarkId: null });
    expect((await a.get("/api/bookmarks/lookup?url=" + encodeURIComponent("https://kakuyomu.jp/"))).body).toEqual({ bookmarked: false, bookmarkId: null });
    expect((await a.get("/api/bookmarks/lookup")).status).toBe(400);
    expect((await client(app).get("/api/bookmarks/lookup?url=x")).status).toBe(401);
  });
});
