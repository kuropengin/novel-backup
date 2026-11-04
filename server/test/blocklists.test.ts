import request from "supertest";
import { describe, expect, it } from "vitest";
import { BLOCKLIST_PRESETS } from "../src/routes/blocklists.js";
import { makeAdmin, makeViewer, setupApp } from "./helpers.js";

async function setup() {
  const { app, db } = setupApp();
  const admin = await makeAdmin(app);
  const viewer = await makeViewer(admin, app);
  return { app, db, admin, viewer };
}
const URL1 = "https://example.com/list.txt";

describe("blocklists", () => {
  it("requires auth", async () => {
    const { app } = await setup();
    expect((await request(app).get("/api/blocklists")).status).toBe(401);
    expect((await request(app).post("/api/blocklists").send({ name: "a", url: URL1 })).status).toBe(401);
    expect((await request(app).patch("/api/blocklists/1").send({ enabled: true })).status).toBe(401);
    expect((await request(app).delete("/api/blocklists/1")).status).toBe(401);
  });

  it("seeds presets with only adguard-dns enabled", async () => {
    const { admin } = await setup();
    const r = await admin.get("/api/blocklists");
    expect(r.status).toBe(200);
    expect(r.body.lists).toHaveLength(BLOCKLIST_PRESETS.length);
    const enabled = r.body.lists.filter((l: { enabled: boolean }) => l.enabled).map((l: { presetKey: string }) => l.presetKey);
    expect(enabled).toEqual(["adguard-dns"]);
    expect(r.body.lists.map((l: { presetKey: string }) => l.presetKey)).toEqual(BLOCKLIST_PRESETS.map((p) => p.key));
  });

  it("re-seed is idempotent, keeps toggles, and seeds newly added presets", async () => {
    const { admin, db } = await setup();
    const first = (await admin.get("/api/blocklists")).body.lists;
    await admin.patch(`/api/blocklists/${first[0].id}`).send({ enabled: false });
    await admin.patch(`/api/blocklists/${first[1].id}`).send({ enabled: true });
    // 後のリリースで追加されたプリセットを想定: 1 件消す
    db.prepare("DELETE FROM user_blocklists WHERE preset_key = 'stevenblack'").run();
    const again = (await admin.get("/api/blocklists")).body.lists;
    expect(again).toHaveLength(BLOCKLIST_PRESETS.length);
    expect(again[0].enabled).toBe(false);
    expect(again[1].enabled).toBe(true);
    expect(again.at(-1).presetKey).toBe("stevenblack");
    expect(again.at(-1).enabled).toBe(false);
    expect((await admin.get("/api/blocklists")).body.lists).toHaveLength(BLOCKLIST_PRESETS.length);
  });

  it("isolates users", async () => {
    const { admin, viewer } = await setup();
    const c = await admin.post("/api/blocklists").send({ name: "mine", url: URL1 });
    expect(c.status).toBe(201);
    const id = c.body.list.id;
    const v = (await viewer.get("/api/blocklists")).body.lists;
    expect(v.some((l: { url: string }) => l.url === URL1)).toBe(false);
    expect((await viewer.patch(`/api/blocklists/${id}`).send({ enabled: false })).status).toBe(404);
    expect((await viewer.delete(`/api/blocklists/${id}`)).status).toBe(404);
    // 他ユーザーが同じ URL を登録しても 409 にならない
    expect((await viewer.post("/api/blocklists").send({ name: "x", url: URL1 })).status).toBe(201);
    const a = (await admin.get("/api/blocklists")).body.lists.find((l: { id: number }) => l.id === id);
    expect(a.enabled).toBe(true);
  });

  it("validates create input", async () => {
    const { admin } = await setup();
    const bad = [
      { name: "", url: URL1 },
      { name: "   ", url: URL1 },
      { name: "x".repeat(65), url: URL1 },
      { name: "a", url: "http://example.com/a.txt" },
      { name: "a", url: "ftp://example.com/a.txt" },
      { name: "a", url: "not a url" },
      { name: "a", url: "https://user:pw@example.com/a.txt" },
      { name: "a", url: "https://127.0.0.1/a.txt" },
      { name: "a", url: "https://192.168.0.1/a.txt" },
      { name: "a", url: "https://[::1]/a.txt" },
      { name: "a", url: "https://localhost/a.txt" },
      { name: "a", url: "https://printer.local/a.txt" },
      { name: "a", url: "https://intranet/a.txt" },
      { name: "a", url: "https://example.com/" + "a".repeat(2048) },
      { name: "a" },
      { name: "a", url: URL1, extra: 1 },
    ];
    for (const b of bad) {
      const r = await admin.post("/api/blocklists").send(b);
      expect(r.status, JSON.stringify(b).slice(0, 80)).toBe(400);
      expect(r.body.error).toBe("validation_error");
    }
    const ok = await admin.post("/api/blocklists").send({ name: "  trimmed  ", url: URL1 });
    expect(ok.status).toBe(201);
    expect(ok.body.list).toMatchObject({ name: "trimmed", url: URL1, presetKey: null, enabled: true });
  });

  it("rejects duplicates (also a preset url) with 409", async () => {
    const { admin } = await setup();
    expect((await admin.post("/api/blocklists").send({ name: "a", url: URL1 })).status).toBe(201);
    const d = await admin.post("/api/blocklists").send({ name: "b", url: URL1 });
    expect(d.status).toBe(409);
    expect(d.body.error).toBe("blocklist_duplicate");
    await admin.get("/api/blocklists");
    const p = await admin.post("/api/blocklists").send({ name: "c", url: BLOCKLIST_PRESETS[0].url });
    expect(p.status).toBe(409);
  });

  it("limits custom lists to 20", async () => {
    const { admin } = await setup();
    for (let i = 0; i < 20; i++) {
      expect((await admin.post("/api/blocklists").send({ name: `n${i}`, url: `https://example.com/${i}.txt` })).status).toBe(201);
    }
    const r = await admin.post("/api/blocklists").send({ name: "over", url: "https://example.com/over.txt" });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("blocklist_limit");
    // プリセットは上限に含まない
    expect((await admin.get("/api/blocklists")).body.lists).toHaveLength(20 + BLOCKLIST_PRESETS.length);
  });

  it("patch toggles preset and custom; delete only custom", async () => {
    const { admin } = await setup();
    const lists = (await admin.get("/api/blocklists")).body.lists;
    const preset = lists[0];
    expect((await admin.patch(`/api/blocklists/${preset.id}`).send({ enabled: false })).body.list.enabled).toBe(false);
    const c = (await admin.post("/api/blocklists").send({ name: "a", url: URL1 })).body.list;
    expect((await admin.patch(`/api/blocklists/${c.id}`).send({ enabled: false })).body.list.enabled).toBe(false);
    expect((await admin.patch(`/api/blocklists/${c.id}`).send({ enabled: "yes" })).status).toBe(400);

    const d = await admin.delete(`/api/blocklists/${preset.id}`);
    expect(d.status).toBe(400);
    expect(d.body.error).toBe("blocklist_preset_undeletable");
    expect((await admin.delete(`/api/blocklists/${c.id}`)).status).toBe(200);
    expect((await admin.delete(`/api/blocklists/${c.id}`)).status).toBe(404);
  });

  it("parses ids strictly", async () => {
    const { admin } = await setup();
    for (const id of ["12abc", "1e3", "-1", "1.5"]) {
      expect((await admin.patch(`/api/blocklists/${id}`).send({ enabled: true })).status).toBe(400);
      expect((await admin.delete(`/api/blocklists/${id}`)).status).toBe(400);
    }
    expect((await admin.patch("/api/blocklists/99999").send({ enabled: true })).status).toBe(404);
  });
});
