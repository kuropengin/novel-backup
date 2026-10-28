import { describe, expect, it } from "vitest";
import { pageInfoCode } from "../src/inject";

describe("pageInfoCode", () => {
  it("自己完結した式(外部参照なし)で、構文として有効", () => {
    const code = pageInfoCode();
    expect(code.startsWith("(")).toBe(true);
    expect(() => new Function(`return ${code}`)).not.toThrow();
  });
  it("3 サイト以外のホストでは URL だけ返す", () => {
    const g = globalThis as unknown as Record<string, unknown>;
    g.location = { hostname: "example.com", href: "https://example.com/", pathname: "/" };
    g.document = { title: "x", querySelector: () => null, querySelectorAll: () => [] };
    try {
      expect(new Function(`return ${pageInfoCode()}`)()).toEqual({ url: "https://example.com/", novelTitle: "", episodeTitle: "", author: "" });
    } finally {
      delete g.location;
      delete g.document;
    }
  });
});
