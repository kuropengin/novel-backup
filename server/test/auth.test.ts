import request from "supertest";
import { describe, expect, it } from "vitest";
import { client, login, makeAdmin, makeViewer, setupApp, SETUP_TOKEN } from "./helpers.js";

describe("auth (bearer only)", () => {
  it("setup returns a token; status reflects it; second setup is 409", async () => {
    const { app, db } = setupApp();
    expect((await request(app).get("/api/auth/status")).body).toEqual({ setupRequired: true, setupEnabled: true, user: null });

    const s = await request(app).post("/api/auth/setup").send({ username: "admin", password: "password123", token: true, setupToken: SETUP_TOKEN });
    expect(s.status).toBe(201);
    expect(s.body.token).toBeTruthy();
    expect(s.body.user).toMatchObject({ username: "admin", role: "admin" });
    expect(s.headers["set-cookie"]).toBeUndefined();
    const days = (Date.parse(s.body.expiresAt) - Date.now()) / 86_400_000;
    expect(Math.round(days)).toBe(90);

    const st = await client(app, s.body.token).get("/api/auth/status");
    expect(st.body.setupRequired).toBe(false);
    expect(st.body.user).toMatchObject({ username: "admin", role: "admin" });
    // トークンは平文で保存されない
    const row = db.prepare("SELECT id_hash FROM sessions").get() as unknown as { id_hash: string };
    expect(row.id_hash).not.toBe(s.body.token);

    const again = await request(app).post("/api/auth/setup").send({ username: "other1", password: "password123", setupToken: SETUP_TOKEN });
    expect(again.status).toBe(409);
  });

  it("setup validates input", async () => {
    const { app } = setupApp();
    const r = await request(app).post("/api/auth/setup").send({ username: "a", password: "short", setupToken: SETUP_TOKEN });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("validation_error");
  });

  it("issues, authenticates and revokes tokens", async () => {
    const { app } = setupApp();
    await makeAdmin(app);
    const bad = await request(app).post("/api/auth/token").send({ username: "admin", password: "wrongpass1" });
    expect(bad.status).toBe(401);
    expect(bad.body).toEqual({ error: "invalid_credentials" });

    const a = await login(app, "admin");
    expect((await a.get("/api/bookmarks")).status).toBe(200);
    expect((await a.post("/api/auth/logout").send({})).status).toBe(200);
    expect((await a.get("/api/bookmarks")).status).toBe(401);
    expect((await a.get("/api/auth/status")).body.user).toBeNull();
  });

  it("rejects missing and invalid tokens; cookies are ignored", async () => {
    const { app } = setupApp();
    await makeAdmin(app);
    expect((await client(app).get("/api/bookmarks")).status).toBe(401);
    expect((await client(app, "nope").get("/api/bookmarks")).status).toBe(401);
    expect((await client(app).post("/api/auth/logout").send({})).status).toBe(401);
    expect((await request(app).get("/api/bookmarks").set("Cookie", "nb_sid=abc")).status).toBe(401);
  });

  it("rate limits token requests per IP", async () => {
    const { app } = setupApp();
    let last = 0;
    for (let i = 0; i < 11; i++) {
      last = (await request(app).post("/api/auth/token").send({ username: "nobody", password: "x" })).status;
    }
    expect(last).toBe(429);
  });

  it("changes password, keeps current token, revokes others", async () => {
    const { app } = setupApp();
    await makeAdmin(app);
    const a = await login(app, "admin");
    const other = await login(app, "admin");
    expect((await a.post("/api/auth/password").send({ currentPassword: "nope", newPassword: "newpassword1" })).status).toBe(401);
    expect((await a.post("/api/auth/password").send({ currentPassword: "password123", newPassword: "newpassword1" })).status).toBe(200);
    expect((await a.get("/api/auth/status")).body.user).not.toBeNull();
    expect((await other.get("/api/auth/status")).body.user).toBeNull();
    await login(app, "admin", "newpassword1");
  });

  it("unknown path returns 404 JSON", async () => {
    const { app } = setupApp();
    const r = await request(app).get("/api/nope");
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: "not_found" });
    expect((await request(app).get("/proxy/narou/ncode.syosetu.com/")).status).toBe(404);
    expect((await request(app).get("/")).body).toEqual({ error: "not_found" });
  });
});

describe("users / roles", () => {
  it("viewer gets 403 on user APIs, admin can manage users", async () => {
    const { app } = setupApp();
    const admin = await makeAdmin(app);
    const viewer = await makeViewer(admin, app);

    expect((await client(app).get("/api/users")).status).toBe(401);
    expect((await viewer.get("/api/users")).status).toBe(403);
    expect((await viewer.post("/api/users").send({ username: "zzz", password: "password123", role: "viewer" })).status).toBe(403);
    expect((await viewer.patch("/api/users/1").send({ role: "viewer" })).status).toBe(403);
    expect((await viewer.delete("/api/users/1")).status).toBe(403);

    const list = await admin.get("/api/users");
    expect(list.status).toBe(200);
    expect(list.body.users).toHaveLength(2);
    expect(JSON.stringify(list.body)).not.toContain("password");

    const dup = await admin.post("/api/users").send({ username: "viewer1", password: "password123", role: "viewer" });
    expect(dup.status).toBe(409);
    const p = await admin.patch("/api/users/2").send({ role: "admin" });
    expect(p.body.user.role).toBe("admin");
  });

  it("protects self and last admin from deletion/demotion", async () => {
    const { app } = setupApp();
    const admin = await makeAdmin(app);
    expect((await admin.delete("/api/users/1")).body.error).toBe("cannot_delete_self");
    expect((await admin.patch("/api/users/1").send({ role: "viewer" })).status).toBe(409);
    const v = await admin.post("/api/users").send({ username: "viewer1", password: "password123", role: "viewer" });
    expect((await admin.delete(`/api/users/${v.body.user.id}`)).status).toBe(200);
    expect((await admin.delete("/api/users/999")).status).toBe(404);
  });

  it("admin password reset invalidates the target's tokens", async () => {
    const { app } = setupApp();
    const admin = await makeAdmin(app);
    const viewer = await makeViewer(admin, app);
    expect((await admin.patch("/api/users/2").send({ password: "another-pass1" })).status).toBe(200);
    expect((await viewer.get("/api/auth/status")).body.user).toBeNull();
    await login(app, "viewer1", "another-pass1");
  });
});
