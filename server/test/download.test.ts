import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb } from "../src/db/index.js";

function setup(withApk: boolean) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nb-apk-"));
  if (withApk) fs.writeFileSync(path.join(dir, "novel-backup.apk"), "PK-dummy");
  return { dir, app: createApp({ db: openDb(":memory:"), apkDir: dir }) };
}

describe("APK download", () => {
  it("serves the page and the APK without auth", async () => {
    const { dir, app } = setup(true);
    const page = await request(app).get("/download");
    expect(page.status).toBe(200);
    expect(page.text).toContain('href="/download/novel-backup.apk"');
    const apk = await request(app).get("/download/novel-backup.apk");
    expect(apk.status).toBe(200);
    expect(apk.headers["content-type"]).toContain("application/vnd.android.package-archive");
    expect(apk.headers["content-disposition"]).toContain("novel-backup.apk");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns 404 when no APK is placed", async () => {
    const { dir, app } = setup(false);
    expect((await request(app).get("/download")).text).toContain("まだ配置されていません");
    expect((await request(app).get("/download/novel-backup.apk")).status).toBe(404);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("is disabled when apkDir is not configured", async () => {
    const app = createApp({ db: openDb(":memory:") });
    expect((await request(app).get("/download")).status).toBe(404);
  });
});
