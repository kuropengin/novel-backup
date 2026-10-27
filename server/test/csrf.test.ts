import request from "supertest";
import { describe, expect, it } from "vitest";
import { setupApp } from "./helpers.js";

const body = { username: "admin", password: "password123" };

describe("csrf origin check", () => {
  it("同一オリジンは許可", async () => {
    const { app } = setupApp();
    const r = await request(app).post("/api/auth/setup").set("Host", "localhost:3000").set("Origin", "http://localhost:3000").send(body);
    expect(r.status).toBe(201);
  });

  it("Host が書き換わっても X-Forwarded-Host が一致すれば許可", async () => {
    const { app } = setupApp();
    const r = await request(app)
      .post("/api/auth/setup")
      .set("Host", "backend:3000")
      .set("X-Forwarded-Host", "novel.example.com")
      .set("Origin", "https://novel.example.com")
      .send(body);
    expect(r.status).toBe(201);
  });

  it("ALLOWED_ORIGINS に含まれるオリジンは許可、それ以外は 403", async () => {
    const { app } = setupApp({ config: { allowedOrigins: ["https://novel.example.com"] } });
    const bad = await request(app).post("/api/auth/setup").set("Origin", "https://evil.example").send(body);
    expect(bad.status).toBe(403);
    expect(bad.body.error).toBe("bad_origin");
    const ok = await request(app).post("/api/auth/setup").set("Host", "backend:3000").set("Origin", "https://novel.example.com").send(body);
    expect(ok.status).toBe(201);
  });
});
