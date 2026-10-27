import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { SiteAdapter, SiteId } from "../src/sites/types.js";
import { makeAdmin, setupApp } from "./helpers.js";

function spyAdapters() {
  const fetchNovel = vi.fn(async () => {
    throw new Error("must not be called");
  });
  const adapter: SiteAdapter = {
    site: "narou",
    displayName: "なろう",
    hosts: ["ncode.syosetu.com"],
    parseUrl: () => null,
    novelUrl: (k: string) => `https://ncode.syosetu.com/${k}/`,
    episodeUrl: (k: string, e: string) => `https://ncode.syosetu.com/${k}/${e}/`,
    fetchNovel,
    fetchEpisode: vi.fn(),
  } as unknown as SiteAdapter;
  return { getAdapter: (_s: SiteId) => adapter, fetchNovel };
}

async function getToken(app: ReturnType<typeof setupApp>["app"]) {
  await makeAdmin(app);
  const r = await request(app).post("/api/auth/token").send({ username: "admin", password: "password123" });
  expect(r.status).toBe(200);
  return r.body.token as string;
}

describe("bearer token auth", () => {
  it("issues, authenticates, and revokes a token", async () => {
    const { app, db } = setupApp();
    await makeAdmin(app);
    const r = await request(app).post("/api/auth/token").send({ username: "admin", password: "password123" });
    expect(r.status).toBe(200);
    expect(r.body.token).toBeTruthy();
    expect(r.body.user).toMatchObject({ username: "admin", role: "admin" });
    const token = r.body.token as string;

    const row = db.prepare("SELECT created_at, expires_at FROM sessions ORDER BY rowid DESC LIMIT 1").get() as unknown as {
      created_at: string;
      expires_at: string;
    };
    const days = (Date.parse(row.expires_at) - Date.parse(row.created_at)) / 86_400_000;
    expect(Math.round(days)).toBe(90);

    const me = await request(app).get("/api/auth/status").set("Authorization", `Bearer ${token}`);
    expect(me.body.user).toMatchObject({ username: "admin" });
    expect((await request(app).get("/api/bookmarks").set("Authorization", `Bearer ${token}`)).status).toBe(200);

    const out = await request(app).post("/api/auth/logout").set("Authorization", `Bearer ${token}`).send({});
    expect(out.status).toBe(200);
    expect((await request(app).get("/api/bookmarks").set("Authorization", `Bearer ${token}`)).status).toBe(401);
  });

  it("rejects bad credentials, missing and invalid tokens", async () => {
    const { app } = setupApp();
    await makeAdmin(app);
    const bad = await request(app).post("/api/auth/token").send({ username: "admin", password: "wrongpass" });
    expect(bad.status).toBe(401);
    expect((await request(app).get("/api/bookmarks")).status).toBe(401);
    expect((await request(app).get("/api/bookmarks").set("Authorization", "Bearer nope")).status).toBe(401);
    expect((await request(app).post("/api/bookmarks").set("Authorization", "Bearer nope").send({ url: "x" })).status).toBe(401);
  });

  it("bearer POST passes the CSRF guard without Cookie, Origin or JSON content-type checks", async () => {
    const { app } = setupApp({ getAdapter: spyAdapters().getAdapter });
    const token = await getToken(app);
    const r = await request(app)
      .post("/api/bookmarks")
      .set("Authorization", `Bearer ${token}`)
      .set("Origin", "https://evil.example")
      .send({ url: "https://ncode.syosetu.com/n1234ab/", title: "T" });
    expect(r.status).toBe(201);
  });

  it("cookie-authenticated requests are still CSRF-checked even with a bearer header", async () => {
    const { app } = setupApp();
    const admin = await makeAdmin(app);
    const r = await admin.post("/api/auth/logout").set("Origin", "https://evil.example").send({});
    expect(r.status).toBe(403);
  });
});

describe("bookmarks with client-supplied title", () => {
  it("creates without calling the site adapter, no backup, and lists url", async () => {
    const sa = spyAdapters();
    const { app, db } = setupApp({ getAdapter: sa.getAdapter });
    const token = await getToken(app);
    const auth = { Authorization: `Bearer ${token}` };

    // 話ページの URL でも作品に解決される
    const c = await request(app)
      .post("/api/bookmarks")
      .set(auth)
      .send({ url: "https://ncode.syosetu.com/n1234ab/5/", title: "My Novel", author: "Me" });
    expect(c.status).toBe(201);
    expect(c.body.bookmark).toMatchObject({ site: "narou", novelKey: "n1234ab", title: "My Novel", author: "Me" });
    expect(sa.fetchNovel).not.toHaveBeenCalled();
    const run = db.prepare("SELECT COUNT(*) AS c FROM backup_runs").get() as unknown as { c: number };
    expect(run.c).toBe(0);

    const list = await request(app).get("/api/bookmarks").set(auth);
    expect(list.body.bookmarks[0].url).toBe("https://ncode.syosetu.com/n1234ab/");

    const dup = await request(app).post("/api/bookmarks").set(auth).send({ url: "https://ncode.syosetu.com/n1234ab/", title: "Other" });
    expect(dup.status).toBe(200);
    expect(dup.body.created).toBe(false);
    expect(dup.body.bookmark.title).toBe("My Novel");
  });

  it("returns 400 not_a_novel_page for non-novel urls", async () => {
    const { app } = setupApp({ getAdapter: spyAdapters().getAdapter });
    const token = await getToken(app);
    for (const url of ["https://yomou.syosetu.com/", "https://example.com/n1234ab/", "https://kakuyomu.jp/"]) {
      const r = await request(app).post("/api/bookmarks").set("Authorization", `Bearer ${token}`).send({ url, title: "X" });
      expect(r.status).toBe(400);
      expect(r.body.error).toBe("not_a_novel_page");
    }
  });

  it("PATCH updates the novel title", async () => {
    const { app } = setupApp({ getAdapter: spyAdapters().getAdapter });
    const token = await getToken(app);
    const auth = { Authorization: `Bearer ${token}` };
    const c = await request(app).post("/api/bookmarks").set(auth).send({ url: "https://ncode.syosetu.com/n1234ab/", title: "Old" });
    const p = await request(app).patch(`/api/bookmarks/${c.body.bookmark.id}`).set(auth).send({ title: "New" });
    expect(p.status).toBe(200);
    expect(p.body.bookmark.title).toBe("New");
    expect((await request(app).patch(`/api/bookmarks/${c.body.bookmark.id}`).set(auth).send({ title: "" })).status).toBe(400);
  });
});
