import { describe, expect, it } from "vitest";
import { buildCss, DEFAULT_DISPLAY, FONT_SIZES_PX, FONT_STACKS, sanitizeDisplay, siteOfHost, type DisplaySettings } from "../src/display";

const HOSTS = { narou: "ncode.syosetu.com", kakuyomu: "kakuyomu.jp", hameln: "syosetu.org" } as const;
const disp = (o: Partial<DisplaySettings> = {}): DisplaySettings => ({ ...DEFAULT_DISPLAY, ...o });

describe("siteOfHost", () => {
  it("3 サイトのホストのみ対象", () => {
    expect(siteOfHost("ncode.syosetu.com")?.id).toBe("narou");
    expect(siteOfHost("yomou.syosetu.com")?.id).toBe("narou");
    expect(siteOfHost("kakuyomu.jp")?.id).toBe("kakuyomu");
    expect(siteOfHost("syosetu.org")?.id).toBe("hameln");
    expect(siteOfHost("www.example.com")).toBeNull();
    expect(siteOfHost("evilsyosetu.com")).toBeNull();
    expect(siteOfHost("syosetu.org.evil.com")).toBeNull();
  });
  it("対象外ホストは CSS を生成しない", () => {
    expect(buildCss("example.com", disp())).toBe("");
  });
});

describe("本文 CSS", () => {
  it("文字サイズ・行間・フォントが本文コンテナに入る", () => {
    const css = buildCss(HOSTS.kakuyomu, disp({ fontSize: 5, lineHeight: 2.2, font: "gothic" }));
    expect(css).toContain(`.widget-episodeBody,.widget-episodeBody p{font-size:${FONT_SIZES_PX[4]}px`);
    expect(css).toContain("line-height:2.2");
    expect(css).toContain(FONT_STACKS.gothic);
  });
  it("明朝", () => {
    expect(buildCss(HOSTS.hameln, disp({ font: "mincho" }))).toContain(FONT_STACKS.mincho);
  });
  it("変更しない(サイト依存)は font-family を出さず、サイズ・行間は残す", () => {
    const css = buildCss(HOSTS.kakuyomu, disp({ fontSize: 5, lineHeight: 2.2, font: "site" }));
    expect(css).not.toContain("font-family");
    expect(css).toContain(`font-size:${FONT_SIZES_PX[4]}px`);
    expect(css).toContain("line-height:2.2");
  });
  it("サイト別の本文セレクタ", () => {
    expect(buildCss(HOSTS.narou, disp())).toContain(".p-novel__text");
    expect(buildCss(HOSTS.hameln, disp())).toMatch(/#honbun.*#maegaki.*#atogaki/s);
  });
  for (const host of Object.values(HOSTS)) {
    it(`${host}: 配色・広告・画像に触れず、すべての規則が本文セレクタ限定`, () => {
      const css = buildCss(host, disp());
      expect(css).not.toMatch(/(^|[;{\s])(background|background-color|background-image|color|display)\s*:/);
      expect(css).not.toMatch(/\b(html|body|img|video|svg|canvas|picture|a)\b[,{ ]/);
      expect(css).not.toMatch(/\bad/i);
      for (const rule of css.split("\n")) {
        const selectors = rule.slice(0, rule.indexOf("{")).split(",");
        for (const s of selectors) expect(s).toMatch(/^(\.p-novel__text|#novel_honbun|#novel_p|#novel_a|\.widget-episodeBody|#honbun|#maegaki|#atogaki)( p| rt)?$/);
      }
    });
  }
});

describe("sanitizeDisplay", () => {
  it("不正値は既定へ", () => {
    expect(sanitizeDisplay({ fontSize: 99, lineHeight: 3, font: "y" })).toEqual(DEFAULT_DISPLAY);
    expect(sanitizeDisplay(null)).toEqual(DEFAULT_DISPLAY);
    expect(sanitizeDisplay({ font: "site" }).font).toBe("site");
  });
  it("正しい値は保持し、旧テーマ/広告設定は捨てる", () => {
    const d = { fontSize: 4, lineHeight: 1.5, font: "gothic" } as const;
    expect(sanitizeDisplay({ ...d, theme: "dark", hideAds: true })).toEqual(d);
  });
});
