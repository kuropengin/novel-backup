import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb } from "../src/db/index.js";
import { DEFAULT_SETTINGS, getSettings, onSettingsChanged } from "../src/settings.js";

function setup() {
  const db = openDb(":memory:");
  const app = createApp({ db });
  return { db, app };
}

/** cookie を保持するエージェント(JSON 送信)。 */
function agent(app: ReturnType<typeof createApp>) {
  const a = request.agent(app);
  return a;
}

async function makeAdmin(app: ReturnType<typeof createApp>) {
  const a = agent(app);
  const res = await a.post("/api/auth/setup").send({ username: "admin", password: "password123" });
  expect(res.status).toBe(201);
  return a;
}

async function makeViewer(admin: ReturnType<typeof agent>, app: ReturnType<typeof createApp>, name = "viewer1") {
  const r = await admin.post("/api/users").send({ username: name, password: "password123", role: "viewer" });
  expect(r.status).toBe(201);
  const v = agent(app);
  const l = await v.post("/api/auth/login").send({ username: name, password: "password123" });
  expect(l.status).toBe(200);
  return v;
}

describe("auth flow", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it("setup -> status -> logout -> login", async () => {
    const a = agent(ctx.app);
    let st = await a.get("/api/auth/status");
    expect(st.body).toEqual({ setupRequired: true, user: null });

    const s = await a.post("/api/auth/setup").send({ username: "admin", password: "password123" });
    expect(s.status).toBe(201);
    expect(s.headers["set-cookie"]?.[0]).toMatch(/nb_sid=.*HttpOnly/);

    st = await a.get("/api/auth/status");
    expect(st.body.setupRequired).toBe(false);
    expect(st.body.user).toMatchObject({ username: "admin", role: "admin" });

    // 2 回目の setup は 409
    const again = await a.post("/api/auth/setup").send({ username: "x1234", password: "password123" });
    expect(again.status).toBe(409);

    expect((await a.post("/api/auth/logout").send({})).status).toBe(200);
    st = await a.get("/api/auth/status");
    expect(st.body.user).toBeNull();

    const bad = await a.post("/api/auth/login").send({ username: "admin", password: "wrongpass1" });
    expect(bad.status).toBe(401);
    expect(bad.body).toEqual({ error: "invalid_credentials" });

    const ok = await a.post("/api/auth/login").send({ username: "admin", password: "password123" });
    expect(ok.status).toBe(200);
    expect((await a.get("/api/auth/status")).body.user.username).toBe("admin");
  });

  it("validates input", async () => {
    const r = await request(ctx.app).post("/api/auth/setup").send({ username: "a", password: "short" });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("validation_error");
  });

  it("requires JSON content-type and same Origin for mutations", async () => {
    const r1 = await request(ctx.app).post("/api/auth/setup").type("form").send("username=admin&password=password123");
    expect(r1.status).toBe(415);
    const r2 = await request(ctx.app)
      .post("/api/auth/setup")
      .set("Origin", "http://evil.example")
      .send({ username: "admin", password: "password123" });
    expect(r2.status).toBe(403);
  });

  it("rate limits login per IP", async () => {
    let last = 0;
    for (let i = 0; i < 11; i++) {
      last = (await request(ctx.app).post("/api/auth/login").send({ username: "nobody", password: "x" })).status;
    }
    expect(last).toBe(429);
  });

  it("changes password and keeps the current session", async () => {
    const a = await makeAdmin(ctx.app);
    const bad = await a.post("/api/auth/password").send({ currentPassword: "nope", newPassword: "newpassword1" });
    expect(bad.status).toBe(401);
    const ok = await a.post("/api/auth/password").send({ currentPassword: "password123", newPassword: "newpassword1" });
    expect(ok.status).toBe(200);
    expect((await a.get("/api/auth/status")).body.user).not.toBeNull();
    const l = await request(ctx.app).post("/api/auth/login").send({ username: "admin", password: "newpassword1" });
    expect(l.status).toBe(200);
  });

  it("unauthenticated requests get 401", async () => {
    expect((await request(ctx.app).get("/api/users")).status).toBe(401);
    expect((await request(ctx.app).get("/api/settings")).status).toBe(401);
    const p = await request(ctx.app).get("/proxy/narou/ncode.syosetu.com/");
    expect(p.status).toBe(401);
  });
});

describe("roles", () => {
  it("viewer gets 403 on admin APIs, admin can manage users", async () => {
    const { app } = setup();
    const admin = await makeAdmin(app);
    const viewer = await makeViewer(admin, app);

    expect((await viewer.get("/api/users")).status).toBe(403);
    expect((await viewer.post("/api/users").send({ username: "zzz", password: "password123", role: "viewer" })).status).toBe(403);
    expect((await viewer.patch("/api/users/1").send({ role: "viewer" })).status).toBe(403);
    expect((await viewer.delete("/api/users/1").send({})).status).toBe(403);
    expect((await viewer.get("/api/settings")).status).toBe(403);
    expect((await viewer.put("/api/settings").send({ requestIntervalMs: 2000 })).status).toBe(403);

    const list = await admin.get("/api/users");
    expect(list.status).toBe(200);
    expect(list.body.users).toHaveLength(2);
    expect(JSON.stringify(list.body)).not.toContain("password");

    const dup = await admin.post("/api/users").send({ username: "viewer1", password: "password123", role: "viewer" });
    expect(dup.status).toBe(409);
  });

  it("protects self and last admin from deletion/demotion", async () => {
    const { app } = setup();
    const admin = await makeAdmin(app);
    expect((await admin.delete("/api/users/1").send({})).status).toBe(409);
    expect((await admin.patch("/api/users/1").send({ role: "viewer" })).status).toBe(409);
    const v = await admin.post("/api/users").send({ username: "viewer1", password: "password123", role: "viewer" });
    expect((await admin.delete(`/api/users/${v.body.user.id}`).send({})).status).toBe(200);
    expect((await admin.delete("/api/users/999").send({})).status).toBe(404);
  });

  it("admin password reset invalidates the target's sessions", async () => {
    const { app } = setup();
    const admin = await makeAdmin(app);
    const viewer = await makeViewer(admin, app);
    expect((await admin.patch("/api/users/2").send({ password: "another-pass1" })).status).toBe(200);
    expect((await viewer.get("/api/auth/status")).body.user).toBeNull();
  });
});

describe("settings", () => {
  it("returns defaults, validates and partially updates, fires hook", async () => {
    const { app } = setup();
    const admin = await makeAdmin(app);
    const { hamelnCookie: _c, ...pub } = DEFAULT_SETTINGS;
    expect((await admin.get("/api/settings")).body).toEqual({ ...pub, hamelnCookieSet: false, hamelnCookieNames: [] });

    let called = 0;
    const off = onSettingsChanged(() => called++);

    expect((await admin.put("/api/settings").send({ backupIntervalMinutes: 10 })).status).toBe(400);
    expect((await admin.put("/api/settings").send({ requestIntervalMs: 500 })).status).toBe(400);
    expect((await admin.put("/api/settings").send({ backupStartAt: "25:00" })).status).toBe(400);
    expect((await admin.put("/api/settings").send({ unknownKey: 1 })).status).toBe(400);
    expect(called).toBe(0);

    const ok = await admin.put("/api/settings").send({ backupIntervalMinutes: 0, backupStartAt: "03:00" });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ backupIntervalMinutes: 0, backupStartAt: "03:00", requestIntervalMs: 1500 });
    expect(called).toBe(1);
    expect((await admin.get("/api/settings")).body.backupStartAt).toBe("03:00");

    expect((await admin.put("/api/settings").send({ backupStartAt: null })).body.backupStartAt).toBeNull();
    off();
  });
});

describe("misc", () => {
  it("unknown /api path returns 404 JSON", async () => {
    const { app } = setup();
    const r = await request(app).get("/api/nope");
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: "not_found" });
  });
});

describe("hameln connection settings", () => {
  const SECRET = "cf_clearance=SECRETVALUE123; sid=abc";

  it("never returns the cookie value; set / keep / clear semantics", async () => {
    const { app, db } = setup();
    const admin = await makeAdmin(app);
    const put = await admin.put("/api/settings").send({ hamelnCookie: SECRET, hamelnUserAgent: "UA/1" });
    expect(put.status).toBe(200);
    expect(put.body.hamelnCookieSet).toBe(true);
    expect(put.body.hamelnCookieNames).toEqual(["cf_clearance", "sid"]);
    expect(put.body.hamelnUserAgent).toBe("UA/1");
    expect(JSON.stringify(put.body)).not.toContain("SECRETVALUE123");
    const get = await admin.get("/api/settings");
    expect(get.body).not.toHaveProperty("hamelnCookie");
    expect(JSON.stringify(get.body)).not.toContain("SECRETVALUE123");
    expect(getSettings(db).hamelnCookie).toBe(SECRET);

    await admin.put("/api/settings").send({ requestIntervalMs: 2000 });
    expect(getSettings(db).hamelnCookie).toBe(SECRET);

    expect((await admin.put("/api/settings").send({ hamelnCookie: "a=b\r\nX: y" })).status).toBe(400);
    expect((await admin.put("/api/settings").send({ hamelnCookie: "x".repeat(8193) })).status).toBe(400);
    expect((await admin.put("/api/settings").send({ hamelnUserAgent: "x".repeat(501) })).status).toBe(400);

    const cleared = await admin.put("/api/settings").send({ hamelnCookie: "" });
    expect(cleared.body.hamelnCookieSet).toBe(false);
    expect(cleared.body.hamelnCookieNames).toEqual([]);
    expect(getSettings(db).hamelnCookie).toBe("");
  });

  it("viewer cannot read or set", async () => {
    const { app, db } = setup();
    const admin = await makeAdmin(app);
    const viewer = await makeViewer(admin, app);
    expect((await viewer.get("/api/settings")).status).toBe(403);
    expect((await viewer.put("/api/settings").send({ hamelnCookie: SECRET })).status).toBe(403);
    expect(getSettings(db).hamelnCookie).toBe("");
  });
});
