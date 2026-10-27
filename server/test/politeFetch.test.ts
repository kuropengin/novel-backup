import { describe, expect, it } from "vitest";
import { createPoliteFetcher, HttpError } from "../src/http/politeFetch.js";
import { SiteBlockedError, SiteNotFoundError } from "../src/sites/types.js";

/** 仮想時計: sleep が時間を進める。fetch 呼び出し時刻を記録 */
function harness(responses: Array<(url: string) => Response | Error>, opts: { interval?: number } = {}) {
  let t = 0;
  const calls: Array<{ url: string; at: number; ua?: string }> = [];
  const sleeps: number[] = [];
  let i = 0;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, at: t, ua: (init?.headers as Record<string, string>)["User-Agent"] });
    const r = responses[Math.min(i++, responses.length - 1)]!(url);
    if (r instanceof Error) throw r;
    return r;
  }) as unknown as typeof fetch;
  const f = createPoliteFetcher({
    fetchImpl,
    getIntervalMs: () => opts.interval ?? 1500,
    userAgent: "test-ua",
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
    backoffBaseMs: 100,
  });
  return { ...f, calls, sleeps };
}

const ok = (body = "ok") => () => new Response(body, { status: 200 });
const status = (s: number, headers: Record<string, string> = {}, body = "") => () => new Response(body, { status: s, headers });

describe("politeFetch", () => {
  it("returns status/url/headers/text and sends UA + Accept-Language", async () => {
    const h = harness([ok("hello")]);
    const r = await h.politeFetch("https://a.example/x");
    expect(r.status).toBe(200);
    expect(r.text).toBe("hello");
    expect(h.calls[0]!.ua).toBe("test-ua");
  });

  it("serializes requests per host with the configured interval; hosts are independent", async () => {
    const h = harness([ok()], { interval: 1000 });
    await Promise.all([
      h.politeFetch("https://a.example/1"),
      h.politeFetch("https://a.example/2"),
      h.politeFetch("https://a.example/3"),
      h.politeFetch("https://b.example/1"),
    ]);
    const a = h.calls.filter((c) => c.url.startsWith("https://a.example")).map((c) => c.at);
    expect(a[1]! - a[0]!).toBeGreaterThanOrEqual(1000);
    expect(a[2]! - a[1]!).toBeGreaterThanOrEqual(1000);
    const b = h.calls.find((c) => c.url.startsWith("https://b.example"))!;
    expect(b.at).toBeLessThan(1000 + 1); // 別ホストは待たされない(a の 2 件目より前)
  });

  it("interactive requests jump the queue and use a shorter interval", async () => {
    const h = harness([ok()], { interval: 1500 });
    const order: string[] = [];
    const run = (u: string, p?: "interactive") => h.politeFetch(u, { priority: p }).then(() => order.push(u));
    await Promise.all([run("https://a.example/n1"), run("https://a.example/n2"), run("https://a.example/i1", "interactive")]);
    // n1 は即時実行中、以降は interactive が n2 より先
    expect(order).toEqual(["https://a.example/n1", "https://a.example/i1", "https://a.example/n2"]);
    const at = Object.fromEntries(h.calls.map((c) => [c.url, c.at]));
    expect(at["https://a.example/i1"]! - at["https://a.example/n1"]!).toBe(300);
  });

  it("retries 5xx / 429 with backoff, honoring Retry-After", async () => {
    const h = harness([status(503), status(429, { "retry-after": "2" }), ok("done")]);
    const r = await h.politeFetch("https://a.example/x");
    expect(r.text).toBe("done");
    expect(h.calls).toHaveLength(3);
    expect(h.sleeps).toContain(100); // 1 回目バックオフ
    expect(h.sleeps).toContain(2000); // Retry-After: 2
  });

  it("retries network errors then gives up after max retries", async () => {
    const h = harness([() => new Error("ECONNRESET")]);
    await expect(h.politeFetch("https://a.example/x")).rejects.toThrow("ECONNRESET");
    expect(h.calls).toHaveLength(4); // 初回 + 3 リトライ
  });

  it("throws HttpError after exhausting retries on 500", async () => {
    const h = harness([status(500)]);
    await expect(h.politeFetch("https://a.example/x")).rejects.toBeInstanceOf(HttpError);
    expect(h.calls).toHaveLength(4);
  });

  it("404 / 410 -> SiteNotFoundError without retry", async () => {
    for (const s of [404, 410]) {
      const h = harness([status(s)]);
      await expect(h.politeFetch("https://a.example/x")).rejects.toBeInstanceOf(SiteNotFoundError);
      expect(h.calls).toHaveLength(1);
    }
  });

  it("other 4xx -> HttpError without retry", async () => {
    const h = harness([status(403, {}, "forbidden")]);
    await expect(h.politeFetch("https://a.example/x")).rejects.toMatchObject({ name: "HttpError", status: 403 });
    expect(h.calls).toHaveLength(1);
  });

  it("Cloudflare challenge -> SiteBlockedError without retry", async () => {
    const h = harness([status(403, { "cf-mitigated": "challenge" }, "<title>Just a moment...</title>")]);
    await expect(h.politeFetch("https://a.example/x")).rejects.toBeInstanceOf(SiteBlockedError);
    expect(h.calls).toHaveLength(1);
    const h2 = harness([status(503, {}, "<html><head><title>Just a moment...</title>")]);
    await expect(h2.politeFetch("https://a.example/x")).rejects.toBeInstanceOf(SiteBlockedError);
  });

  it("a failed request does not stall the queue", async () => {
    const h = harness([status(404), ok("fine")]);
    const [a, b] = await Promise.allSettled([h.politeFetch("https://a.example/1"), h.politeFetch("https://a.example/2")]);
    expect(a.status).toBe("rejected");
    expect(b.status).toBe("fulfilled");
  });

  it("reads the interval lazily from the injected getter", async () => {
    let interval = 5000;
    const h = harness([ok()]);
    h.deps.getIntervalMs = () => interval;
    await h.politeFetch("https://a.example/1");
    interval = 1000;
    await h.politeFetch("https://a.example/2");
    expect(h.calls[1]!.at - h.calls[0]!.at).toBe(1000);
  });
});

describe("hameln cookie", () => {
  function make(handler: (url: string) => Response, auth = { cookie: "cf_clearance=abc", userAgent: "my-browser-ua" }) {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, headers: { ...(init.headers as Record<string, string>) } });
      return handler(url);
    }) as unknown as typeof fetch;
    const f = createPoliteFetcher({
      fetchImpl,
      userAgent: "default-ua",
      getIntervalMs: () => 0,
      sleep: async () => {},
      getHamelnAuth: () => auth,
    });
    return { ...f, calls };
  }

  it("attaches Cookie/UA only to syosetu.org hosts", async () => {
    const h = make(() => new Response("ok"));
    await h.politeFetch("https://syosetu.org/novel/1/");
    await h.politeFetch("https://img.syosetu.org/a.png");
    await h.politeFetch("https://ncode.syosetu.com/n1234a/");
    await h.politeFetch("https://kakuyomu.jp/works/1");
    await h.politeFetch("https://api.syosetu.com/novelapi/api/");
    expect(h.calls[0]!.headers.Cookie).toBe("cf_clearance=abc");
    expect(h.calls[0]!.headers["User-Agent"]).toBe("my-browser-ua");
    expect(h.calls[1]!.headers.Cookie).toBe("cf_clearance=abc");
    for (const c of h.calls.slice(2)) {
      expect(c.headers.Cookie).toBeUndefined();
      expect(c.headers["User-Agent"]).toBe("default-ua");
    }
  });

  it("does not forward Cookie when redirected to another host", async () => {
    const h = make((url) =>
      url.startsWith("https://syosetu.org/")
        ? new Response(null, { status: 302, headers: { location: "https://example.com/x" } })
        : new Response("done"),
    );
    const r = await h.politeFetch("https://syosetu.org/a");
    expect(r.text).toBe("done");
    expect(h.calls).toHaveLength(2);
    expect(h.calls[0]!.headers.Cookie).toBe("cf_clearance=abc");
    expect(h.calls[1]!.headers.Cookie).toBeUndefined();
    expect(h.calls[1]!.headers["User-Agent"]).toBe("default-ua");
  });

  it("no cookie: nothing sent; UA override still applies", async () => {
    const h = make(() => new Response("ok"), { cookie: "", userAgent: "ua-only" });
    await h.politeFetch("https://syosetu.org/a");
    expect(h.calls[0]!.headers.Cookie).toBeUndefined();
    expect(h.calls[0]!.headers["User-Agent"]).toBe("ua-only");
  });
});
