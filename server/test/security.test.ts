import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import bcrypt from "bcryptjs";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { BackupScheduler } from "../src/backup/scheduler.js";
import { FailureBackoff, ipKey, RateLimiter } from "../src/http/rateLimit.js";
import { normalizeNovelKey } from "../src/sites.js";
import { login, makeAdmin, makeViewer, setupApp, SETUP_TOKEN } from "./helpers.js";

/** BackupScheduler の最小モック */
function mockScheduler(running = false) {
  return {
    enqueueNovel: vi.fn(),
    trigger: vi.fn(async () => {}),
    getStatus: vi.fn((): { running: boolean } => ({ running })),
    getConfig: vi.fn(() => ({ frequency: "daily", time: "03:00", maxParallel: 3 })),
    updateConfig: vi.fn(),
    onProgress: vi.fn(() => () => {}),
  };
}
const asScheduler = (s: ReturnType<typeof mockScheduler>) => () => s as unknown as BackupScheduler;

describe("novel key validation", () => {
  it("validates per site and normalizes narou", () => {
    expect(normalizeNovelKey("narou", "N1234AB")).toBe("n1234ab");
    expect(normalizeNovelKey("narou", "n12345abc")).toBeNull();
    expect(normalizeNovelKey("narou", "../x")).toBeNull();
    expect(normalizeNovelKey("hameln", "123456")).toBe("123456");
    expect(normalizeNovelKey("hameln", "12345678901")).toBeNull();
    expect(normalizeNovelKey("kakuyomu", "1".repeat(25))).toBe("1".repeat(25));
    expect(normalizeNovelKey("kakuyomu", "1".repeat(26))).toBeNull();
    expect(normalizeNovelKey("kakuyomu", "12a")).toBeNull();
  });
});

describe("per-novel trigger", () => {
  it("validates site/key and normalizes", async () => {
    const sch = mockScheduler();
    const { app } = setupApp({ getScheduler: asScheduler(sch) });
    const admin = await makeAdmin(app);
    expect((await admin.post("/api/backup/novels/foo/123/trigger").send({})).status).toBe(400);
    expect((await admin.post("/api/backup/novels/narou/abc/trigger").send({})).status).toBe(400);
    expect((await admin.post("/api/backup/novels/hameln/12ab/trigger").send({})).status).toBe(400);
    expect(sch.enqueueNovel).not.toHaveBeenCalled();
    const ok = await admin.post("/api/backup/novels/narou/N1234AB/trigger").send({});
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ enqueued: true, site: "narou", novelKey: "n1234ab" });
    expect(sch.enqueueNovel).toHaveBeenCalledWith("narou", ["n1234ab"], 100);
    expect(sch.trigger).toHaveBeenCalledTimes(1);
  });

  it("does not start a new cycle while one is running", async () => {
    const sch = mockScheduler(true);
    const { app } = setupApp({ getScheduler: asScheduler(sch) });
    const admin = await makeAdmin(app);
    const r = await admin.post("/api/backup/novels/hameln/123/trigger").send({});
    expect(r.status).toBe(200);
    expect(sch.enqueueNovel).toHaveBeenCalled();
    expect(sch.trigger).not.toHaveBeenCalled();
  });

  it("rate limits viewers with 429 { error, retryAfter } and Retry-After", async () => {
    const sch = mockScheduler();
    const { app } = setupApp({ getScheduler: asScheduler(sch) });
    const admin = await makeAdmin(app);
    const viewer = await makeViewer(admin, app);
    for (let i = 0; i < 5; i++) expect((await viewer.post("/api/backup/novels/hameln/123/trigger").send({})).status).toBe(200);
    const r = await viewer.post("/api/backup/novels/hameln/123/trigger").send({});
    expect(r.status).toBe(429);
    expect(r.body.error).toBe("rate_limited");
    expect(r.body.retryAfter).toBeGreaterThan(0);
    expect(r.headers["retry-after"]).toBe(String(r.body.retryAfter));
    // 管理者は別枠(上限が高い)
    expect((await admin.post("/api/backup/novels/hameln/123/trigger").send({})).status).toBe(200);
  });
});

describe("enqueue", () => {
  it("validates with zod and normalizes keys", async () => {
    const sch = mockScheduler();
    const { app } = setupApp({ getScheduler: asScheduler(sch) });
    const admin = await makeAdmin(app);
    const post = (b: unknown) => admin.post("/api/backup/enqueue").send(b as object);
    expect((await post({ site: "x", novelKeys: ["1"] })).status).toBe(400);
    expect((await post({ site: "narou", novelKeys: [] })).status).toBe(400);
    expect((await post({ site: "narou", novelKeys: ["bad"] })).status).toBe(400);
    expect((await post({ site: "hameln", novelKeys: Array(201).fill("1") })).status).toBe(400);
    expect((await post({ site: "hameln", novelKeys: ["1"], priority: 1000 })).status).toBe(400);
    expect(sch.enqueueNovel).not.toHaveBeenCalled();
    const ok = await post({ site: "narou", novelKeys: ["N1234AB", "n1234ab"] });
    expect(ok.status).toBe(200);
    expect(ok.body.count).toBe(1);
    expect(sch.enqueueNovel).toHaveBeenCalledWith("narou", ["n1234ab"], 0);
  });
});

describe("settings time validation", () => {
  it("rejects out-of-range times", async () => {
    const sch = mockScheduler();
    const { app } = setupApp({ getScheduler: asScheduler(sch) });
    const admin = await makeAdmin(app);
    const put = (time: string) => admin.put("/api/backup/settings").send({ frequency: "daily", time, maxParallel: 3 });
    for (const t of ["24:00", "99:99", "12:60", "7:00"]) expect((await put(t)).status).toBe(400);
    for (const t of ["00:00", "23:59"]) expect((await put(t)).status).toBe(200);
  });
});

describe("error responses", () => {
  it("never leaks error messages on 500", async () => {
    const sch = mockScheduler();
    sch.getStatus.mockImplementation(() => {
      throw new Error("secret internal detail");
    });
    const { app } = setupApp({ getScheduler: asScheduler(sch) });
    const admin = await makeAdmin(app);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await admin.get("/api/backup/status");
    spy.mockRestore();
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: "internal_error" });
  });

  it("notification ids must be strict integers", async () => {
    const { app } = setupApp();
    const admin = await makeAdmin(app);
    expect((await admin.post("/api/notifications/12abc/read").send({})).status).toBe(400);
    expect((await admin.delete("/api/notifications/1e3")).status).toBe(400);
    expect((await admin.post("/api/notifications/5/read").send({})).status).toBe(200);
  });
});

describe("setup token", () => {
  it("unset -> 403 setup_disabled, status still reports setupRequired", async () => {
    const { app } = setupApp({ setupToken: undefined });
    const st = await request(app).get("/api/auth/status");
    expect(st.body).toMatchObject({ setupRequired: true, setupEnabled: false });
    const r = await request(app).post("/api/auth/setup").send({ username: "admin", password: "password123", setupToken: "x" });
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: "setup_disabled" });
  });

  it("wrong/missing token -> 403, right token -> 201", async () => {
    const { app } = setupApp();
    const body = { username: "admin", password: "password123" };
    expect((await request(app).post("/api/auth/setup").send(body)).status).toBe(403);
    const bad = await request(app).post("/api/auth/setup").send({ ...body, setupToken: "wrong" });
    expect(bad.status).toBe(403);
    expect(bad.body.error).toBe("invalid_setup_token");
    expect((await request(app).post("/api/auth/setup").send({ ...body, setupToken: SETUP_TOKEN })).status).toBe(201);
  });

  it("rate limits setup attempts", async () => {
    const { app } = setupApp();
    let last = 0;
    for (let i = 0; i < 6; i++) {
      last = (await request(app).post("/api/auth/setup").send({ username: "admin", password: "password123", setupToken: "w" })).status;
    }
    expect(last).toBe(429);
  });
});

describe("login lockout / password limits", () => {
  it("locks a username after 5 failures (even with correct password), keyed case-insensitively", async () => {
    const { app } = setupApp();
    await makeAdmin(app);
    for (let i = 0; i < 5; i++) {
      const name = i % 2 ? "ADMIN" : "admin";
      expect((await request(app).post("/api/auth/token").send({ username: name, password: "wrongpass1" })).status).toBe(401);
    }
    const locked = await request(app).post("/api/auth/token").send({ username: "Admin", password: "password123" });
    expect(locked.status).toBe(429);
    expect(locked.body.retryAfter).toBeGreaterThan(0);
    expect(locked.body.retryAfter).toBeLessThanOrEqual(60);
    expect(locked.headers["retry-after"]).toBeDefined();
  });

  it("FailureBackoff doubles up to the cap and resets on success", () => {
    const b = new FailureBackoff(5, 60_000, 15 * 60_000);
    const t0 = 1_000_000;
    for (let i = 0; i < 5; i++) b.fail("u", t0);
    expect(b.lockedFor("u", t0)).toBe(60);
    b.fail("u", t0 + 61_000);
    expect(b.lockedFor("u", t0 + 61_000)).toBe(120);
    for (let i = 0; i < 10; i++) b.fail("u", t0 + 61_000);
    expect(b.lockedFor("u", t0 + 61_000)).toBe(900);
    b.success("u");
    expect(b.lockedFor("u", t0 + 61_000)).toBe(0);
  });

  it("successful logins reset the failure count", async () => {
    const { app } = setupApp();
    await makeAdmin(app);
    for (let i = 0; i < 4; i++) {
      await request(app).post("/api/auth/token").send({ username: "admin", password: "wrongpass1" });
    }
    await login(app, "admin");
    for (let i = 0; i < 4; i++) {
      expect((await request(app).post("/api/auth/token").send({ username: "admin", password: "wrongpass1" })).status).toBe(401);
    }
  });

  it("rate limits password changes", async () => {
    const { app } = setupApp();
    await makeAdmin(app);
    const a = await login(app, "admin");
    let last = 0;
    for (let i = 0; i < 11; i++) {
      last = (await a.post("/api/auth/password").send({ currentPassword: "wrong-pass", newPassword: "newpassword1" })).status;
    }
    expect(last).toBe(429);
  });

  it("rehashes passwords stored with a lower cost on login", async () => {
    const { app, db } = setupApp();
    await makeAdmin(app);
    db.prepare("UPDATE users SET password_hash = ?").run(bcrypt.hashSync("password123", 4));
    process.env.BCRYPT_COST = "5";
    try {
      await login(app, "admin");
    } finally {
      process.env.BCRYPT_COST = "4";
    }
    const row = db.prepare("SELECT password_hash FROM users").get() as unknown as { password_hash: string };
    expect(row.password_hash).toMatch(/^\$2[ab]\$05\$/);
  });
});

describe("rate limiter internals", () => {
  it("purges expired entries", () => {
    const l = new RateLimiter(1, 1000);
    for (let i = 0; i < 100; i++) l.take(`k${i}`, 0);
    expect(l.size).toBe(100);
    l.take("new", 70_000);
    expect(l.size).toBe(1);
  });

  it("keys IPv6 by /64", () => {
    expect(ipKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe(ipKey("2001:db8:1:2::1"));
    expect(ipKey("2001:db8:1:3::1")).not.toBe(ipKey("2001:db8:1:2::1"));
    expect(ipKey("::ffff:1.2.3.4")).toBe("1.2.3.4");
    expect(ipKey("1.2.3.4")).toBe("1.2.3.4");
  });
});

describe("security headers / body limits", () => {
  it("sets headers on all responses and no-store on /api", async () => {
    const { app } = setupApp();
    const r = await request(app).get("/api/health");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["referrer-policy"]).toBe("no-referrer");
    expect(r.headers["x-frame-options"]).toBe("DENY");
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.headers["strict-transport-security"]).toBeUndefined();
    const nf = await request(app).get("/nope");
    expect(nf.headers["x-content-type-options"]).toBe("nosniff");
    expect(nf.headers["cache-control"]).toBeUndefined();
  });

  it("sends HSTS only for HTTPS via the trusted proxy", async () => {
    const { app } = setupApp();
    const r = await request(app).get("/api/health").set("X-Forwarded-Proto", "https");
    expect(r.headers["strict-transport-security"]).toContain("max-age=");
  });

  it("limits auth bodies to 16kb", async () => {
    const { app } = setupApp();
    const r = await request(app).post("/api/auth/token").send({ username: "a", password: "x".repeat(20_000) });
    expect(r.status).toBe(413);
    expect(r.body.error).toBe("bad_request");
  });
});

describe("SSE connection limit", () => {
  it("allows 3 per user, 429 for the 4th, and frees slots on close", async () => {
    const sch = mockScheduler();
    const { app } = setupApp({ getScheduler: asScheduler(sch) });
    const admin = await makeAdmin(app);
    const server = http.createServer(app).listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const port = (server.address() as AddressInfo).port;
    const open = (token: string) =>
      new Promise<http.IncomingMessage>((resolve, reject) => {
        const req = http.get(
          { host: "127.0.0.1", port, path: "/api/backup/progress", headers: { Authorization: `Bearer ${token}` } },
          resolve,
        );
        req.on("error", reject);
      });
    const opened: http.IncomingMessage[] = [];
    try {
      for (let i = 0; i < 3; i++) {
        const r = await open(admin.token!);
        expect(r.statusCode).toBe(200);
        opened.push(r);
      }
      const fourth = await open(admin.token!);
      expect(fourth.statusCode).toBe(429);
      fourth.resume();
      // 1 本閉じると再び接続できる
      opened[0]!.destroy();
      await vi.waitFor(async () => {
        const again = await open(admin.token!);
        expect(again.statusCode).toBe(200);
        opened.push(again);
      });
    } finally {
      for (const r of opened) r.destroy();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  });
});

describe("download SHA-256", () => {
  it("shows the APK hash and CSP", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nb-apk-"));
    fs.writeFileSync(path.join(dir, "novel-backup.apk"), "PK-dummy");
    const { app } = setupApp({ apkDir: dir });
    const page = await request(app).get("/download");
    expect(page.text).toContain(crypto.createHash("sha256").update("PK-dummy").digest("hex"));
    expect(page.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(page.headers["x-frame-options"]).toBe("DENY");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
