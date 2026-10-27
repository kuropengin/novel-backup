import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hamelnAdapter, parseHamelnEpisode, parseHamelnNovelPage } from "../src/sites/hameln.js";
import { getAdapter, resolveUrl } from "../src/sites/index.js";
import { kakuyomuAdapter, parseKakuyomuEpisode, parseKakuyomuWork } from "../src/sites/kakuyomu.js";
import {
  narouAdapter,
  narouMetaFromApi,
  parseNarouApi,
  parseNarouEpisode,
  parseNarouTocPage,
} from "../src/sites/narou.js";
import { htmlToText, sanitizeBody } from "../src/sites/sanitize.js";
import { SiteBlockedError, SiteNotFoundError } from "../src/sites/types.js";
import { parseJstDate } from "../src/sites/util.js";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const fx = (n: string) => fs.readFileSync(path.join(dir, n), "utf8");

describe("parseUrl / resolveUrl", () => {
  it("narou", () => {
    expect(resolveUrl("https://ncode.syosetu.com/N9669BK/")).toEqual({ site: "narou", novelKey: "n9669bk", episodeKey: undefined });
    expect(resolveUrl("https://ncode.syosetu.com/n9669bk/12/")).toEqual({ site: "narou", novelKey: "n9669bk", episodeKey: "12" });
    expect(resolveUrl("https://ncode.syosetu.com/n9669bk")).toMatchObject({ novelKey: "n9669bk" });
    expect(resolveUrl("https://ncode.syosetu.com/n9669bk/?p=2")).toMatchObject({ novelKey: "n9669bk" });
    expect(resolveUrl("https://ncode.syosetu.com/")).toBeNull();
    expect(resolveUrl("https://yomou.syosetu.com/rank/top/")).toBeNull();
    expect(resolveUrl("https://ncode.syosetu.com/novelview/infotop/ncode/n9669bk/")).toBeNull();
  });
  it("kakuyomu", () => {
    expect(resolveUrl("https://kakuyomu.jp/works/123")).toMatchObject({ site: "kakuyomu", novelKey: "123" });
    expect(resolveUrl("https://kakuyomu.jp/works/123/episodes/456")).toEqual({ site: "kakuyomu", novelKey: "123", episodeKey: "456" });
    expect(resolveUrl("https://kakuyomu.jp/works/123/episodes/456?x=1")).toMatchObject({ episodeKey: "456" });
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
  it("proxy paths", () => {
    expect(resolveUrl("/proxy/narou/ncode.syosetu.com/n1234ab/1/")).toEqual({ site: "narou", novelKey: "n1234ab", episodeKey: "1" });
    expect(resolveUrl("/proxy/kakuyomu/kakuyomu.jp/works/9/episodes/8")).toEqual({ site: "kakuyomu", novelKey: "9", episodeKey: "8" });
    expect(resolveUrl("/proxy/hameln/syosetu.org/novel/5/3.html")).toEqual({ site: "hameln", novelKey: "5", episodeKey: "3" });
    expect(resolveUrl("http://localhost:3000/proxy/narou/ncode.syosetu.com/n1234ab/?p=2")).toMatchObject({ novelKey: "n1234ab" });
  });
  it("rejects disallowed hosts, mismatched site/host, junk", () => {
    expect(resolveUrl("/proxy/narou/evil.example.com/n1234ab/1/")).toBeNull();
    expect(resolveUrl("/proxy/kakuyomu/ncode.syosetu.com/n1234ab/1/")).toBeNull();
    expect(resolveUrl("/proxy/nope/ncode.syosetu.com/n1234ab/1/")).toBeNull();
    expect(resolveUrl("/proxy/narou/")).toBeNull();
    expect(resolveUrl("https://example.com/works/1")).toBeNull();
    expect(resolveUrl("javascript:alert(1)")).toBeNull();
    expect(resolveUrl("not a url ::")).toBeNull();
  });
  it("adapter url builders", () => {
    expect(narouAdapter.episodeUrl("N1A", "3")).toBe("https://ncode.syosetu.com/n1a/3/");
    expect(narouAdapter.episodeUrl("n1234ab", "short")).toBe("https://ncode.syosetu.com/n1234ab/");
    expect(hamelnAdapter.episodeUrl("5", "3")).toBe("https://syosetu.org/novel/5/3.html");
    expect(kakuyomuAdapter.episodeUrl("1", "2")).toBe("https://kakuyomu.jp/works/1/episodes/2");
    expect(getAdapter("narou").hosts[0]).toBe("ncode.syosetu.com");
  });
});

describe("parseJstDate", () => {
  it("converts JST to UTC ISO", () => {
    expect(parseJstDate("2012/11/22 17:00")).toBe("2012-11-22T08:00:00.000Z");
    expect(parseJstDate("2012-11-22 17:00:34")).toBe("2012-11-22T08:00:34.000Z");
    expect(parseJstDate("2016年03月04日(金) 12:06")).toBe("2016-03-04T03:06:00.000Z");
    expect(parseJstDate("2016年3月4日")).toBe("2016-03-03T15:00:00.000Z");
    expect(parseJstDate("nope")).toBeUndefined();
  });
});

describe("sanitize", () => {
  it("strips scripts, handlers, ids; keeps ruby; absolutizes urls", () => {
    const out = sanitizeBody(
      `<p id="L1" onclick="x()">a<ruby>漢<rp>(</rp><rt>かん</rt><rp>)</rp></ruby><script>alert(1)</script></p>` +
        `<img src="/img/a.png" alt="x" onerror="y()"><img src="javascript:alert(1)"><a href="javascript:alert(1)">bad</a>` +
        `<a href="/n/2/">ok</a><span class="kenten" style="color:red">k</span><iframe src="x"></iframe>`,
      "https://ncode.syosetu.com/n1/1/",
    );
    expect(out).not.toMatch(/script|onclick|onerror|javascript:|iframe|id=|style=/);
    expect(out).toContain("<ruby>漢<rp>(</rp><rt>かん</rt><rp>)</rp></ruby>");
    expect(out).toContain('src="https://ncode.syosetu.com/img/a.png"');
    expect(out).toContain('href="https://ncode.syosetu.com/n/2/"');
    expect(out).toContain('<span class="kenten">k</span>');
    expect((out.match(/<img/g) ?? []).length).toBe(1);
  });
  it("htmlToText", () => {
    expect(htmlToText("<p>あ<br>い</p><p>う<ruby>漢<rt>かん</rt></ruby></p>")).toBe("あ\nい\nう漢");
  });
});

describe("narou parsers", () => {
  it("api: serial / short / ongoing / none", () => {
    const serial = narouMetaFromApi(parseNarouApi(JSON.parse(fx("narou_api_serial.json"))), "N9669BK");
    expect(serial).toMatchObject({
      site: "narou",
      novelKey: "n9669bk",
      title: "テスト連載",
      author: "作者",
      authorUrl: "https://mypage.syosetu.com/288399/",
      status: "completed",
      isShortStory: false,
      tags: ["R15", "残酷な描写あり", "異世界転生"],
      synopsis: "あらすじ1行目\nあらすじ2行目",
    });
    const short = parseNarouApi(JSON.parse(fx("narou_api_short.json")));
    expect(short.isShort).toBe(true);
    expect(short.firstUp).toBe("2026-10-08T13:17:51.000Z");
    expect(narouMetaFromApi(parseNarouApi(JSON.parse(fx("narou_api_ongoing.json"))), "n3289ds").status).toBe("ongoing");
    expect(() => parseNarouApi(JSON.parse(fx("narou_api_none.json")))).toThrow(SiteNotFoundError);
  });
  it("toc page with chapters, revisions and pager", () => {
    const p = parseNarouTocPage(fx("narou_toc_p1.html"));
    expect(p.lastPage).toBe(3);
    expect(p.lastChapter).toBe("第２章　少年期");
    expect(p.entries.map((e) => [e.episodeKey, e.title, e.chapter])).toEqual([
      ["1", "プロローグ", "第１章　幼年期"],
      ["2", "第一話「もしかして：異世界」", "第１章　幼年期"],
      ["13", "第十二話", "第２章　少年期"],
    ]);
    expect(p.entries[0]).toMatchObject({ publishedAt: "2012-11-22T08:00:00.000Z", updatedAt: "2013-11-27T04:06:00.000Z" });
    expect(p.entries[1]).toMatchObject({ publishedAt: "2012-11-22T09:15:00.000Z", updatedAt: "2012-11-22T09:15:00.000Z" });
  });
  it("toc page 2 carries the chapter from previous page", () => {
    const p = parseNarouTocPage(fx("narou_toc_p2.html"), "第２章　少年期");
    expect(p.entries).toHaveLength(1);
    expect(p.entries[0]).toMatchObject({ episodeKey: "101", chapter: "第２章　少年期", updatedAt: "2014-01-01T18:04:00.000Z" });
    expect(p.lastPage).toBe(3);
  });
  it("legacy toc layout", () => {
    const p = parseNarouTocPage(fx("narou_toc_legacy.html"));
    expect(p.entries).toEqual([
      {
        episodeKey: "1",
        title: "旧第一話",
        chapter: "旧章",
        publishedAt: "2010-01-01T18:04:00.000Z",
        updatedAt: "2011-02-02T19:05:00.000Z",
      },
    ]);
  });
  it("episode with preface/afterword", () => {
    const e = parseNarouEpisode(fx("narou_episode.html"), "1", "https://ncode.syosetu.com/n9669bk/1/");
    expect(e.title).toBe("プロローグ");
    expect(htmlToText(e.prefaceHtml!)).toBe("前書きです。");
    expect(htmlToText(e.afterwordHtml!)).toBe("後書きです。");
    expect(e.bodyHtml).toContain("本文一行目。");
    expect(e.bodyHtml).toContain("<ruby>");
    expect(e.bodyHtml).not.toMatch(/script|alert/);
    expect(e.bodyHtml).toContain('href="https://ncode.syosetu.com/n9669bk/2/"');
  });
  it("episode without preface; blank afterword dropped", () => {
    const e = parseNarouEpisode(fx("narou_episode_plain.html"), "short", "https://ncode.syosetu.com/n1/");
    expect(e.prefaceHtml).toBeUndefined();
    expect(e.afterwordHtml).toBeUndefined();
    expect(htmlToText(e.bodyHtml)).toBe("本文のみ。");
  });
  it("legacy episode layout", () => {
    const e = parseNarouEpisode(fx("narou_episode_legacy.html"), "1", "https://ncode.syosetu.com/n1/1/");
    expect(e.title).toBe("旧話タイトル");
    expect(htmlToText(e.prefaceHtml!)).toBe("旧前書き");
    expect(htmlToText(e.bodyHtml)).toBe("旧本文");
    expect(htmlToText(e.afterwordHtml!)).toBe("旧後書き");
  });
});

describe("kakuyomu parsers", () => {
  it("work with chapters", () => {
    const n = parseKakuyomuWork(fx("kakuyomu_work.html"), "111");
    expect(n).toMatchObject({
      site: "kakuyomu",
      novelKey: "111",
      title: "テスト作品",
      author: "表示名",
      authorUrl: "https://kakuyomu.jp/users/someone",
      status: "ongoing",
      tags: ["タグ1", "タグ2"],
      synopsis: "あらすじ\n二行目",
      isShortStory: false,
    });
    expect(n.episodes.map((e) => [e.episodeKey, e.index, e.title, e.chapter])).toEqual([
      ["e1", 0, "プロローグ", undefined],
      ["e2", 1, "第一話", "第一部"],
      ["e3", 2, "第二話", "第一部 / 一章"],
    ]);
    expect(n.episodes[0]!.publishedAt).toBe("2017-03-25T11:30:18.000Z");
    expect(n.episodes[1]!.updatedAt).toBe("2017-03-26T11:30:18.000Z");
  });
  it("single-episode completed work, alternate author name", () => {
    const n = parseKakuyomuWork(fx("kakuyomu_work_completed.html"), "222");
    expect(n.status).toBe("completed");
    expect(n.author).toBe("別名");
    expect(n.episodes).toHaveLength(1);
  });
  it("missing work -> not found", () => {
    expect(() => parseKakuyomuWork(fx("kakuyomu_work.html"), "000")).toThrow(SiteNotFoundError);
  });
  it("episode", () => {
    const e = parseKakuyomuEpisode(fx("kakuyomu_episode.html"), "e1", "https://kakuyomu.jp/works/1/episodes/e1");
    expect(e.title).toBe("第一話");
    expect(e.prefaceHtml).toBeUndefined();
    expect(e.bodyHtml).toContain("本文一行目。");
    expect(e.bodyHtml).toContain('src="https://cdn.example.com/a.png"');
    expect(e.bodyHtml).not.toMatch(/onerror|id=/);
  });
});

describe("hameln parsers (synthetic fixtures; live DOM unverified)", () => {
  it("novel page with chapters", () => {
    const n = parseHamelnNovelPage(fx("hameln_novel.html"), "1");
    expect(n).toMatchObject({
      site: "hameln",
      title: "テスト作品",
      author: "作者名",
      authorUrl: "https://syosetu.org/user/1234/",
      status: "completed",
      tags: ["タグA", "タグB"],
      synopsis: "あらすじ一行目\nあらすじ二行目",
      isShortStory: false,
    });
    expect(n.episodes.map((e) => [e.episodeKey, e.title, e.chapter])).toEqual([
      ["1", "プロローグ", "第一章"],
      ["2", "第一話", "第一章"],
      ["3", "第二話", "第二章"],
    ]);
    expect(n.episodes[0]).toMatchObject({ publishedAt: "2016-03-04T03:06:00.000Z", updatedAt: "2020-01-01T18:04:00.000Z" });
    expect(n.episodes[1]!.updatedAt).toBe(n.episodes[1]!.publishedAt);
  });
  it("short story", () => {
    const n = parseHamelnNovelPage(fx("hameln_short.html"), "2");
    expect(n.isShortStory).toBe(true);
    expect(n.episodes).toHaveLength(1);
    expect(n.episodes[0]).toMatchObject({ episodeKey: "short", title: "短編テスト" });
    const e = parseHamelnEpisode(fx("hameln_short.html"), "short", "https://syosetu.org/novel/2/");
    expect(htmlToText(e.prefaceHtml!)).toBe("前書き");
    expect(htmlToText(e.bodyHtml)).toBe("短編本文。");
    expect(htmlToText(e.afterwordHtml!)).toBe("後書き");
  });
  it("episode", () => {
    const e = parseHamelnEpisode(fx("hameln_episode.html"), "1", "https://syosetu.org/novel/1/1.html");
    expect(e.title).toBe("第一話");
    expect(htmlToText(e.prefaceHtml!)).toBe("前書き文");
    expect(e.afterwordHtml).toBeUndefined();
    expect(e.bodyHtml).toContain("<ruby>漢字<rt>かんじ</rt></ruby>");
  });
  it("Cloudflare challenge page -> SiteBlockedError", () => {
    expect(() => parseHamelnNovelPage(fx("hameln_challenge.html"), "1")).toThrow(SiteBlockedError);
    expect(() => parseHamelnEpisode(fx("hameln_challenge.html"), "1", "https://syosetu.org/")).toThrow(SiteBlockedError);
  });
});

describe.skipIf(process.env.LIVE_TEST !== "1")("live smoke (LIVE_TEST=1)", () => {
  it("narou serial", async () => {
    const info = await narouAdapter.fetchNovel("n9669bk");
    expect(info.episodes.length).toBeGreaterThan(100);
    const ep = await narouAdapter.fetchEpisode("n9669bk", "1");
    expect(ep.bodyHtml.length).toBeGreaterThan(100);
  }, 60_000);
  it("narou short", async () => {
    const info = await narouAdapter.fetchNovel("n0490mw");
    expect(info.isShortStory).toBe(true);
    expect((await narouAdapter.fetchEpisode("n0490mw", "short")).bodyHtml.length).toBeGreaterThan(100);
  }, 60_000);
  it("kakuyomu serial and short", async () => {
    const info = await kakuyomuAdapter.fetchNovel("16817330658389432505");
    expect(info.episodes.length).toBeGreaterThan(10);
    const ep = await kakuyomuAdapter.fetchEpisode("16817330658389432505", info.episodes[0]!.episodeKey);
    expect(ep.bodyHtml.length).toBeGreaterThan(100);
    const s = await kakuyomuAdapter.fetchNovel("1177354054881239629");
    expect(s.episodes).toHaveLength(1);
  }, 60_000);
  it("hameln (may be blocked by Cloudflare)", async () => {
    try {
      const info = await hamelnAdapter.fetchNovel("298");
      expect(info.title).not.toBe("");
    } catch (e) {
      expect(e).toBeInstanceOf(SiteBlockedError);
    }
  }, 60_000);
});
