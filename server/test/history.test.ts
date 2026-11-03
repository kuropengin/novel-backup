import { describe, expect, it } from "vitest";
import { client, makeAdmin, makeViewer, setupApp } from "./helpers.js";

const NAROU = "https://ncode.syosetu.com/n1234ab/";
type C = ReturnType<typeof client>;
const post = (c: C, url: string, extra: object = {}) => c.post("/api/history").send({ url, ...extra });
const count = (db: { prepare(s: string): { get(): unknown } }) => (db.prepare("SELECT COUNT(*) AS c FROM history").get() as { c: number }).c;

describe("history API", () => {
  it("requires auth", async () => {
    const { app } = setupApp();
    expect((await client(app).get("/api/history")).status).toBe(401);
    expect((await client(app, "x").post("/api/history").send({ url: NAROU })).status).toBe(401);
    expect((await client(app, "x").delete("/api/history")).status).toBe(401);
  });

  it("upserts per page, keeps titles when later posts omit them", async () => {
    const { app, db } = setupApp();
    const a = await makeAdmin(app);
    const r1 = await post(a, `${NAROU}3/`, { novelTitle: "N", episodeTitle: "第3話", viewedAt: "2026-01-01T00:00:00.000Z" });
    expect(r1.status).toBe(200);
    expect(r1.body.history).toMatchObject({ site: "narou", novelKey: "n1234ab", episodeKey: "3", novelTitle: "N", episodeTitle: "第3話" });
    const r2 = await post(a, `${NAROU}3/`, { viewedAt: "2026-01-02T00:00:00.000Z" });
    expect(r2.body.history).toMatchObject({ id: r1.body.history.id, novelTitle: "N", episodeTitle: "第3話", viewedAt: "2026-01-02T00:00:00.000Z" });
    // 古い時刻で巻き戻さない(タイトルは更新される)
    const r3 = await post(a, `${NAROU}3/`, { episodeTitle: "改題", viewedAt: "2025-01-01T00:00:00Z" });
    expect(r3.body.history).toMatchObject({ viewedAt: "2026-01-02T00:00:00.000Z", episodeTitle: "改題" });
    expect(count(db)).toBe(1);
    // 未来の時刻は現在に丸める
    const f = await post(a, `${NAROU}4/`, { viewedAt: "2999-01-01T00:00:00Z" });
    expect(new Date(f.body.history.viewedAt).getTime()).toBeLessThan(Date.now() + 5000);
    // 作品ページは episodeKey ''
    const n = await post(a, NAROU, { novelTitle: "N", episodeTitle: "無視される" });
    expect(n.body.history).toMatchObject({ episodeKey: "", episodeTitle: "" });
  });

  it("validates input", async () => {
    const { app } = setupApp();
    const a = await makeAdmin(app);
    for (const url of ["https://yomou.syosetu.com/", "https://example.com/", "nonsense"]) {
      const r = await post(a, url);
      expect(r.status).toBe(400);
      expect(r.body.error).toBe("not_a_novel_page");
    }
    expect((await a.post("/api/history").send({})).status).toBe(400);
    expect((await post(a, NAROU, { viewedAt: "yesterday" })).status).toBe(400);
    expect((await a.get("/api/history?view=bogus")).status).toBe(400);
    expect((await a.get("/api/history?limit=0")).status).toBe(400);
    expect((await a.delete("/api/history?site=narou")).status).toBe(400);
  });

  async function seed(a: C) {
    await post(a, "https://ncode.syosetu.com/n1234ab/1/", { novelTitle: "Alpha", episodeTitle: "はじまり", viewedAt: "2026-01-01T00:00:00Z" });
    await post(a, "https://ncode.syosetu.com/n1234ab/2/", { novelTitle: "Alpha", episodeTitle: "つづき", viewedAt: "2026-01-02T00:00:00Z" });
    await post(a, "https://kakuyomu.jp/works/123", { novelTitle: "Beta", viewedAt: "2026-01-03T00:00:00Z" }); // 作品ページのみ
    await post(a, "https://syosetu.org/novel/9/1.html", { novelTitle: "Gamma", episodeTitle: "G1", viewedAt: "2026-01-04T00:00:00Z" });
    await post(a, "https://ncode.syosetu.com/n1234ab/", { novelTitle: "Alpha", viewedAt: "2026-01-05T00:00:00Z" }); // 最後に作品ページ
  }

  it("episode view: episodes only (no novel-page rows), newest first, q, paging", async () => {
    const { app } = setupApp();
    const a = await makeAdmin(app);
    await seed(a);
    const all = (await a.get("/api/history")).body;
    expect(all.view).toBe("episode");
    // 作品ページのみの閲覧(Alpha/, Beta/)はエピソード毎には出さない
    expect(all.history.map((h: { novelTitle: string; episodeKey: string }) => `${h.novelTitle}/${h.episodeKey}`)).toEqual([
      "Gamma/1",
      "Alpha/2",
      "Alpha/1",
    ]);
    expect((await a.get("/api/history?q=つづ")).body.history).toHaveLength(1);
    expect((await a.get("/api/history?q=alpha")).body.history).toHaveLength(2);
    expect((await a.get("/api/history?q=%25")).body.history).toHaveLength(0); // ワイルドカードは無効
    const page = (await a.get("/api/history?limit=2&offset=1")).body.history;
    expect(page.map((h: { novelTitle: string; episodeKey: string }) => `${h.novelTitle}/${h.episodeKey}`)).toEqual(["Alpha/2", "Alpha/1"]);
  });

  it("novel view: aggregates, prefers episode rows, counts episodes, filters", async () => {
    const { app } = setupApp();
    const a = await makeAdmin(app);
    await seed(a);
    const nv = (await a.get("/api/history?view=novel")).body;
    expect(nv.view).toBe("novel");
    expect(nv.history).toHaveLength(3);
    // 最終閲覧順: Alpha(01-05), Gamma(01-04), Beta(01-03)
    expect(nv.history.map((h: { novelTitle: string }) => h.novelTitle)).toEqual(["Alpha", "Gamma", "Beta"]);
    // 代表は最後に読んだ「話」(2)、作品ページ行ではない。閲覧話数 2、最終閲覧は作品ページ閲覧の時刻
    expect(nv.history[0]).toMatchObject({
      site: "narou",
      novelKey: "n1234ab",
      episodeKey: "2",
      episodeTitle: "つづき",
      url: "https://ncode.syosetu.com/n1234ab/2/",
      episodeCount: 2,
      viewedAt: "2026-01-05T00:00:00.000Z",
    });
    // 作品ページのみ → 話数 0、episodeKey ''
    expect(nv.history[2]).toMatchObject({ novelTitle: "Beta", episodeKey: "", episodeCount: 0, url: "https://kakuyomu.jp/works/123" });
    // q は話タイトルでも作品名でも当たり、作品単位で返る
    const q1 = (await a.get("/api/history?view=novel&q=はじまり")).body.history;
    expect(q1).toHaveLength(1);
    expect(q1[0]).toMatchObject({ novelTitle: "Alpha", episodeCount: 2, episodeKey: "2" });
    expect((await a.get("/api/history?view=novel&q=gam")).body.history).toHaveLength(1);
    expect((await a.get("/api/history?view=novel&limit=1&offset=1")).body.history[0].novelTitle).toBe("Gamma");
  });

  it("per-user isolation", async () => {
    const { app } = setupApp();
    const a = await makeAdmin(app);
    const v = await makeViewer(a, app);
    await seed(a);
    await post(v, `${NAROU}7/`, { novelTitle: "Mine", episodeTitle: "v7" });
    expect((await v.get("/api/history")).body.history).toHaveLength(1);
    expect((await v.get("/api/history?view=novel")).body.history).toHaveLength(1);
    expect((await a.get("/api/history")).body.history).toHaveLength(3);
    const aliceEp = (await a.get("/api/history")).body.history.find((h: { episodeKey: string; site: string }) => h.site === "narou" && h.episodeKey === "2");
    expect(aliceEp.novelTitle).toBe("Alpha");
    // 他人の行は消せない。作品単位/全消去も自分の分だけ
    expect((await v.delete(`/api/history/${aliceEp.id}`)).status).toBe(404);
    expect((await v.delete("/api/history?site=narou&novelKey=n1234ab")).body.deleted).toBe(1);
    expect((await a.get("/api/history")).body.history).toHaveLength(3);
    await v.delete("/api/history");
    expect((await a.get("/api/history")).body.history).toHaveLength(3);
  });

  it("deletes one row, a novel, or everything", async () => {
    const { app } = setupApp();
    const a = await makeAdmin(app);
    await seed(a);
    const rows = (await a.get("/api/history")).body.history;
    const g = rows.find((h: { novelTitle: string }) => h.novelTitle === "Gamma");
    expect((await a.delete(`/api/history/${g.id}`)).status).toBe(200);
    expect((await a.delete(`/api/history/${g.id}`)).status).toBe(404);
    expect((await a.delete("/api/history/abc")).status).toBe(404);
    const d = await a.delete("/api/history?site=narou&novelKey=n1234ab");
    expect(d.body).toEqual({ ok: true, deleted: 3 });
    // 残りは Beta の作品ページ行のみ(エピソード毎には出ないが作品毎には出る)
    expect((await a.get("/api/history")).body.history).toHaveLength(0);
    expect((await a.get("/api/history?view=novel")).body.history).toHaveLength(1);
    expect((await a.delete("/api/history")).body.deleted).toBe(1);
    expect((await a.get("/api/history")).body.history).toHaveLength(0);
  });

  it("is removed when the user is deleted", async () => {
    const { app, db } = setupApp();
    const a = await makeAdmin(app);
    const v = await makeViewer(a, app);
    await post(v, `${NAROU}1/`);
    const users = (await a.get("/api/users")).body.users as { id: number; username: string }[];
    await a.delete(`/api/users/${users.find((u) => u.username === "viewer1")!.id}`);
    expect(count(db)).toBe(0);
  });
});
