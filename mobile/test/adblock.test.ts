import { describe, expect, it } from "vitest";
import { enabledUrls, parseCache, serializeCache, statusView } from "../src/logic/adblock";

describe("enabledUrls", () => {
  it("有効なものだけを重複なし・順序保持で返し、https 以外は除く", () => {
    expect(
      enabledUrls([
        { url: "https://a.example/1", enabled: true },
        { url: "https://b.example/2", enabled: false },
        { url: "http://c.example/3", enabled: true },
        { url: "https://a.example/1", enabled: true },
        { url: "https://d.example/4", enabled: true },
      ]),
    ).toEqual(["https://a.example/1", "https://d.example/4"]);
    expect(enabledUrls([])).toEqual([]);
  });
});

describe("URL キャッシュ", () => {
  it("同じユーザーなら復元できる", () => {
    expect(parseCache(serializeCache("alice", ["https://a.example/1"]), "alice")).toEqual(["https://a.example/1"]);
  });
  it("別ユーザー・壊れた値・未保存は null(持ち越さない)", () => {
    const raw = serializeCache("alice", ["https://a.example/1"]);
    expect(parseCache(raw, "bob")).toBeNull();
    expect(parseCache(raw, "")).toBeNull();
    expect(parseCache("{oops", "alice")).toBeNull();
    expect(parseCache('{"user":"alice","urls":"x"}', "alice")).toBeNull();
    expect(parseCache(null, "alice")).toBeNull();
  });
  it("https 以外や文字列以外は取り除く", () => {
    expect(parseCache('{"user":"a","urls":["http://x.example/","https://y.example/",1]}', "a")).toEqual(["https://y.example/"]);
  });
});

describe("statusView", () => {
  const ok = { url: "u", domains: 1234, updatedAt: Date.UTC(2026, 10, 4, 3, 0), error: null };
  it("オフ / 未取得", () => {
    expect(statusView(false, undefined).kind).toBe("off");
    expect(statusView(true, undefined).kind).toBe("pending");
  });
  it("成功: 件数と最終更新(年を含む)", () => {
    const v = statusView(true, ok);
    expect(v.kind).toBe("ok");
    expect(v.domains).toBe(1234);
    expect(v.updated).toMatch(/^2026\/11\/\d+ \d\d:\d\d$/);
  });
  it("失敗: キャッシュ無しは error、あれば cached-error", () => {
    expect(statusView(true, { url: "u", domains: 0, updatedAt: null, error: "HTTP 404" }).kind).toBe("error");
    const c = statusView(true, { ...ok, error: "timeout" });
    expect(c.kind).toBe("cached-error");
    expect(c.domains).toBe(1234);
    expect(c.error).toBe("timeout");
  });
});
