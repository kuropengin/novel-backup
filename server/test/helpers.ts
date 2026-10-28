import request from "supertest";
import { expect } from "vitest";
import { createApp } from "../src/app.js";
import { openDb } from "../src/db/index.js";

export type App = ReturnType<typeof createApp>;

export function setupApp() {
  const db = openDb(":memory:");
  const app = createApp({ db });
  return { db, app };
}

/** Bearer トークン付きで呼ぶ薄いクライアント。 */
export function client(app: App, token?: string) {
  const h = (r: request.Test) => (token ? r.set("Authorization", `Bearer ${token}`) : r);
  return {
    token,
    get: (p: string) => h(request(app).get(p)),
    post: (p: string) => h(request(app).post(p)),
    patch: (p: string) => h(request(app).patch(p)),
    delete: (p: string) => h(request(app).delete(p)),
  };
}
export type Client = ReturnType<typeof client>;

export async function makeAdmin(app: App) {
  const res = await request(app).post("/api/auth/setup").send({ username: "admin", password: "password123" });
  expect(res.status).toBe(201);
  return client(app, res.body.token as string);
}

export async function login(app: App, username: string, password = "password123") {
  const l = await request(app).post("/api/auth/token").send({ username, password });
  expect(l.status).toBe(200);
  return client(app, l.body.token as string);
}

export async function makeViewer(admin: Client, app: App, name = "viewer1") {
  const r = await admin.post("/api/users").send({ username: name, password: "password123", role: "viewer" });
  expect(r.status).toBe(201);
  return login(app, name);
}
