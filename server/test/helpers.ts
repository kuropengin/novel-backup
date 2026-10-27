import request from "supertest";
import { expect } from "vitest";
import { createApp, type CreateAppOptions } from "../src/app.js";
import { openDb } from "../src/db/index.js";

export type App = ReturnType<typeof createApp>;

export function setupApp(opts: Omit<CreateAppOptions, "db"> = {}) {
  const db = openDb(":memory:");
  const app = createApp({ db, ...opts });
  return { db, app };
}

export async function makeAdmin(app: App) {
  const a = request.agent(app);
  const res = await a.post("/api/auth/setup").send({ username: "admin", password: "password123" });
  expect(res.status).toBe(201);
  return a;
}

export async function makeViewer(admin: ReturnType<typeof request.agent>, app: App, name = "viewer1") {
  const r = await admin.post("/api/users").send({ username: name, password: "password123", role: "viewer" });
  expect(r.status).toBe(201);
  const v = request.agent(app);
  const l = await v.post("/api/auth/login").send({ username: name, password: "password123" });
  expect(l.status).toBe(200);
  return v;
}
