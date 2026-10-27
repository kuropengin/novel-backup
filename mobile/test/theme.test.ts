import { describe, expect, it } from "vitest";
import {
  buildCss,
  buildMinimalCss,
  DEFAULT_DISPLAY,
  FONT_SIZES_PX,
  FONT_STACKS,
  HAMELN_AD_SELECTORS,
  KAKUYOMU_AD_SELECTORS,
  NAROU_AD_SELECTORS,
  PALETTES,
  sanitizeDisplay,
  siteOfHost,
  THEMES,
  type DisplaySettings,
} from "../src/theme";

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
    expect(buildMinimalCss("example.com", disp())).toBe("");
  });
});

describe("テーマ毎のトークン", () => {
  for (const host of Object.values(HOSTS)) {
    for (const t of THEMES) {
      it(`${host} / ${t}: 配色トークンが入る`, () => {
        const css = buildCss(host, disp({ theme: t }));
        const p = PALETTES[t];
        for (const c of [p.bg, p.fg, p.link, p.linkVisited, p.border, p.surface, p.accent]) expect(css).toContain(c);
        expect(css).toContain(`html,body{background-color:${p.bg} !important;color:${p.fg} !important;}`);
        expect(buildMinimalCss(host, disp({ theme: t }))).toContain(p.bg);
      });
    }
  }
  it("テーマ間で bg が異なる", () => {
    const bgs = new Set(THEMES.map((t) => PALETTES[t].bg));
    expect(bgs.size).toBe(3);
  });
  it("★ボタン/トーストがテーマ色になる", () => {
    const css = buildCss(HOSTS.narou, disp({ theme: "dark" }));
    expect(css).toContain(`#nb-star{background-color:${PALETTES.dark.accent} !important`);
    expect(css).toContain("#nb-toast");
  });
});

describe("本文設定", () => {
  it("文字サイズ・行間・フォントが本文コンテナに入る", () => {
    const css = buildCss(HOSTS.kakuyomu, disp({ fontSize: 5, lineHeight: 2.2, font: "gothic" }));
    expect(css).toContain(`.widget-episodeBody,.widget-episodeBody p{font-size:${FONT_SIZES_PX[4]}px`);
    expect(css).toContain("line-height:2.2");
    expect(css).toContain(FONT_STACKS.gothic);
  });
  it("明朝", () => {
    expect(buildCss(HOSTS.hameln, disp({ font: "mincho" }))).toContain(FONT_STACKS.mincho);
  });
});

describe("広告セレクタ", () => {
  const cases = [
    ["narou", NAROU_AD_SELECTORS],
    ["kakuyomu", KAKUYOMU_AD_SELECTORS],
    ["hameln", HAMELN_AD_SELECTORS],
  ] as const;
  for (const [site, sels] of cases) {
    it(`${site}: ON で全セレクタが display:none`, () => {
      const css = buildCss(HOSTS[site], disp({ hideAds: true }));
      for (const s of sels) expect(css).toContain(s);
      expect(css).toContain("display:none !important");
    });
    it(`${site}: OFF で広告セレクタも display:none も含まれない`, () => {
      const css = buildCss(HOSTS[site], disp({ hideAds: false }));
      for (const s of sels) expect(css).not.toContain(s);
      expect(css).not.toContain("display:none");
    });
    it(`${site}: 広すぎるセレクタを使わない`, () => {
      for (const s of sels) {
        expect(s).not.toMatch(/\[class\*=["']?ad["']?\]/i);
        expect(s).not.toMatch(/^\[(class|id)\*=["']ad/i);
      }
    });
  }
  it("サイト固有セレクタ(実ページで確認)", () => {
    expect(NAROU_AD_SELECTORS).toContain(".c-ad");
    expect(KAKUYOMU_AD_SELECTORS).toContain('[id^="top-ad-"]');
  });
  it("ハーメルンは汎用セレクタのみ", () => {
    expect(HAMELN_AD_SELECTORS).toContain("ins.adsbygoogle");
    expect(HAMELN_AD_SELECTORS).toContain('[id^="div-gpt-ad"]');
  });
});

describe("画像・アイコンを壊さない", () => {
  for (const host of Object.values(HOSTS)) {
    it(`${host}: img/svg 等を指定せず、background ショートハンド/background-image に触れない`, () => {
      const css = buildCss(host, disp());
      expect(css).not.toMatch(/\b(img|video|svg|canvas|picture)\b/);
      expect(css).not.toMatch(/background-image/);
      expect(css).not.toMatch(/(^|[;{\s])background\s*:/);
      expect(css).toContain("background-color:transparent !important");
    });
  }
});

describe("sanitizeDisplay", () => {
  it("不正値は既定へ", () => {
    expect(sanitizeDisplay({ theme: "x", fontSize: 99, lineHeight: 3, font: "y", hideAds: "no" })).toEqual(DEFAULT_DISPLAY);
    expect(sanitizeDisplay(null)).toEqual(DEFAULT_DISPLAY);
  });
  it("正しい値は保持", () => {
    const d = { theme: "sepia", fontSize: 4, lineHeight: 1.5, font: "gothic", hideAds: false } as const;
    expect(sanitizeDisplay(d)).toEqual(d);
  });
});
