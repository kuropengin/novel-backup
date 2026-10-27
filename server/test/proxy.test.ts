import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { PoliteFetchResult } from "../src/http/politeFetch.js";
import { SiteBlockedError } from "../src/sites/types.js";
import { makeAdmin, setupApp } from "./helpers.js";

function res(url: string, body: string | Buffer, contentType: string, extra: Record<string, string> = {}): PoliteFetchResult {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  return { status: 200, url, headers: new Headers({ "content-type": contentType, ...extra }), text: "", body: buf };
}

function setup(fetcher: (url: string) => Promise<PoliteFetchResult>) {
  const f = vi.fn(fetcher);
  const ctx = setupApp({ proxy: { fetcher: f as never } });
  return { ...ctx, f };
}

describe("/proxy", () => {
  it("requires auth (401 plain text)", async () => {
    const { app, f } = setup(async (u) => res(u, "x", "text/html"));
    const r = await request(app).get("/proxy/narou/yomou.syosetu.com/");
    expect(r.status).toBe(401);
    expect(r.headers["content-type"]).toMatch(/text\/plain/);
    expect((await request(app).get("/proxy/img?url=https://static.syosetu.com/a.png")).status).toBe(401);
    expect(f).not.toHaveBeenCalled();
  });

  it("rejects disallowed hosts with 400 and never fetches", async () => {
    const { app, f } = setup(async (u) => res(u, "x", "text/html"));
    const a = await makeAdmin(app);
    for (const p of [
      "/proxy/narou/example.com/",
      "/proxy/narou/kakuyomu.jp/", // 別サイトのホスト
      "/proxy/unknown/yomou.syosetu.com/",
      "/proxy/narou/127.0.0.1/",
      "/proxy/narou/localhost/",
      "/proxy/narou/yomou.syosetu.com.evil.com/",
      "/proxy/asset?url=" + encodeURIComponent("https://example.com/a.css"),
      "/proxy/img?url=" + encodeURIComponent("http://169.254.169.254/latest"),
      "/proxy/img?url=" + encodeURIComponent("file:///etc/passwd"),
      "/proxy/img",
    ]) {
      const r = await a.get(p);
      expect(r.status, p).toBe(400);
    }
    expect(f).not.toHaveBeenCalled();
  });

  it("only allows GET", async () => {
    const { app, f } = setup(async (u) => res(u, "x", "text/html"));
    const a = await makeAdmin(app);
    expect((await a.post("/proxy/narou/yomou.syosetu.com/").send({})).status).toBe(405);
    expect((await a.post("/proxy/post-disabled").send({})).status).toBe(405);
    expect((await a.get("/proxy/post-disabled")).status).toBe(405);
    expect(f).not.toHaveBeenCalled();
  });

  it("returns rewritten HTML with CSP and without Set-Cookie", async () => {
    const { app, f } = setup(async (u) =>
      res(u, `<html><head><script>x()</script></head><body><a href="/ranking/">r</a></body></html>`, "text/html; charset=utf-8", {
        "set-cookie": "a=b",
        "x-frame-options": "DENY",
      }),
    );
    const a = await makeAdmin(app);
    const r = await a.get("/proxy/narou/yomou.syosetu.com/?x=1");
    expect(r.status).toBe(200);
    expect(f.mock.calls[0]![0]).toBe("https://yomou.syosetu.com/?x=1");
    expect(r.text).not.toContain("<script");
    expect(r.text).toContain('href="/proxy/narou/yomou.syosetu.com/ranking/"');
    expect(r.headers["content-security-policy"]).toContain("script-src 'none'");
    expect(r.headers["content-security-policy"]).toContain("frame-ancestors 'self'");
    expect(r.headers["set-cookie"]).toBeUndefined();
    expect(r.headers["x-frame-options"]).toBeUndefined();
  });

  it("refuses redirects to hosts outside the whitelist", async () => {
    const { app } = setup(async () => res("https://example.com/", "<html></html>", "text/html"));
    const a = await makeAdmin(app);
    expect((await a.get("/proxy/narou/yomou.syosetu.com/")).status).toBe(502);
  });

  it("shows a clear HTML message when the site is blocked", async () => {
    const { app } = setup(async () => {
      throw new SiteBlockedError("blocked", "challenge");
    });
    const a = await makeAdmin(app);
    const r = await a.get("/proxy/hameln/syosetu.org/");
    expect(r.status).toBe(502);
    expect(r.headers["content-type"]).toMatch(/text\/html/);
    expect(r.text).toContain("ブロック");
  });

  it("serves images via /proxy/img with caching, rejects non-images", async () => {
    const { app } = setup(async (u) =>
      u.endsWith(".png") ? res(u, Buffer.from([1, 2, 3]), "image/png", { "set-cookie": "z=1" }) : res(u, "<html></html>", "text/html"),
    );
    const a = await makeAdmin(app);
    const ok = await a.get("/proxy/img?url=" + encodeURIComponent("https://4044.mitemin.net/a.png"));
    expect(ok.status).toBe(200);
    expect(ok.headers["content-type"]).toBe("image/png");
    expect(ok.headers["cache-control"]).toContain("max-age=86400");
    expect(ok.headers["set-cookie"]).toBeUndefined();
    const bad = await a.get("/proxy/img?url=" + encodeURIComponent("https://4044.mitemin.net/a.html"));
    expect(bad.status).toBe(415);
  });

  it("rewrites CSS url() served via /proxy/asset", async () => {
    const { app } = setup(async (u) => res(u, "a{background:url(i.png)}", "text/css"));
    const a = await makeAdmin(app);
    const r = await a.get("/proxy/asset?url=" + encodeURIComponent("https://static.syosetu.com/css/a.css"));
    expect(r.status).toBe(200);
    expect(r.text).toContain("/proxy/asset?url=" + encodeURIComponent("https://static.syosetu.com/css/i.png"));
  });
});
