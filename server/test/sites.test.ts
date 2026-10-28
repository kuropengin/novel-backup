import { describe, expect, it } from "vitest";
import { novelUrl, resolveUrl } from "../src/sites.js";

describe("resolveUrl", () => {
  it("narou", () => {
    expect(resolveUrl("https://ncode.syosetu.com/N9669BK/")).toEqual({ site: "narou", novelKey: "n9669bk", episodeKey: undefined });
    expect(resolveUrl("https://ncode.syosetu.com/n9669bk/12/")).toEqual({ site: "narou", novelKey: "n9669bk", episodeKey: "12" });
    expect(resolveUrl("https://ncode.syosetu.com/n9669bk/?p=2")).toMatchObject({ novelKey: "n9669bk" });
    expect(resolveUrl("https://ncode.syosetu.com/")).toBeNull();
    expect(resolveUrl("https://yomou.syosetu.com/rank/top/")).toBeNull();
    expect(resolveUrl("https://ncode.syosetu.com/novelview/infotop/ncode/n9669bk/")).toBeNull();
  });
  it("kakuyomu", () => {
    expect(resolveUrl("https://kakuyomu.jp/works/123")).toMatchObject({ site: "kakuyomu", novelKey: "123" });
    expect(resolveUrl("https://kakuyomu.jp/works/123/episodes/456?x=1")).toEqual({ site: "kakuyomu", novelKey: "123", episodeKey: "456" });
    expect(resolveUrl("https://kakuyomu.jp/")).toBeNull();
    expect(resolveUrl("https://kakuyomu.jp/users/abc")).toBeNull();
  });
  it("hameln", () => {
    expect(resolveUrl("https://syosetu.org/novel/298/")).toEqual({ site: "hameln", novelKey: "298", episodeKey: undefined });
    expect(resolveUrl("https://syosetu.org/novel/298")).toMatchObject({ novelKey: "298" });
    expect(resolveUrl("https://syosetu.org/novel/298/12.html")).toEqual({ site: "hameln", novelKey: "298", episodeKey: "12" });
    expect(resolveUrl("https://syosetu.org/?mode=ss_detail&nid=298")).toMatchObject({ novelKey: "298" });
    expect(resolveUrl("https://syosetu.org/")).toBeNull();
  });
  it("rejects other hosts, schemes and garbage", () => {
    expect(resolveUrl("https://example.com/works/1")).toBeNull();
    expect(resolveUrl("javascript:alert(1)")).toBeNull();
    expect(resolveUrl("/novel/1/")).toBeNull();
    expect(resolveUrl("not a url")).toBeNull();
  });
});

describe("novelUrl", () => {
  it("builds canonical urls", () => {
    expect(novelUrl("narou", "N1234AB")).toBe("https://ncode.syosetu.com/n1234ab/");
    expect(novelUrl("hameln", "298")).toBe("https://syosetu.org/novel/298/");
    expect(novelUrl("kakuyomu", "123")).toBe("https://kakuyomu.jp/works/123");
  });
});
