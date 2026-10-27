import { describe, expect, it } from "vitest";
import * as cheerio from "cheerio";
import { isAssetHost, parseAssetUrl, POST_DISABLED_PATH, rewriteCss, rewriteHtml, toProxyPagePath } from "../src/proxy/rewrite.js";

const page = new URL("https://yomou.syosetu.com/search.php?word=a");

function $of(html: string, url = page) {
  return cheerio.load(rewriteHtml(html, url));
}

describe("rewriteHtml", () => {
  it("removes script, iframe, base, meta refresh and on* attributes", () => {
    const $ = $of(`<html><head><base href="https://evil.example/"><meta http-equiv="refresh" content="0;url=https://evil.example/">
      <script>alert(1)</script><script src="https://x/y.js"></script></head>
      <body onload="x()"><a href="/a" onclick="x()">a</a><iframe src="https://ad.example"></iframe>
      <noscript><img src="/n.png"></noscript><object data="x"></object></body></html>`);
    expect($("script").length).toBe(0);
    expect($("iframe, object, base").length).toBe(0);
    expect($('meta[http-equiv]').length).toBe(0);
    expect($("body").attr("onload")).toBeUndefined();
    expect($("a").attr("onclick")).toBeUndefined();
    // noscript は展開される
    expect($("noscript").length).toBe(0);
    expect($("img").length).toBe(1);
  });

  it("rewrites links to allowed hosts into /proxy paths", () => {
    const $ = $of(`<a href="/n1234ab/">x</a><a href="https://ncode.syosetu.com/n1/2/#top">y</a>
      <a href="?p=2">z</a><a href="https://kakuyomu.jp/works/1">k</a>`);
    const hrefs = $("a").map((_i, e) => $(e).attr("href")).get();
    expect(hrefs).toEqual([
      "/proxy/narou/yomou.syosetu.com/n1234ab/",
      "/proxy/narou/ncode.syosetu.com/n1/2/#top",
      "/proxy/narou/yomou.syosetu.com/search.php?p=2",
      "/proxy/kakuyomu/kakuyomu.jp/works/1",
    ]);
  });

  it("opens disallowed hosts in a new tab with the original URL", () => {
    const $ = $of(`<a href="https://example.com/x" target="_self">x</a><a href="//twitter.com/a">t</a><a href="mailto:a@b.c">m</a>`);
    const a = $("a").eq(0);
    expect(a.attr("href")).toBe("https://example.com/x");
    expect(a.attr("target")).toBe("_blank");
    expect(a.attr("rel")).toBe("noopener noreferrer");
    expect($("a").eq(1).attr("href")).toBe("https://twitter.com/a");
    expect($("a").eq(2).attr("href")).toBe("mailto:a@b.c");
  });

  it("drops javascript: links", () => {
    const $ = $of(`<a href="javascript:alert(1)">x</a>`);
    expect($("a").attr("href")).toBeUndefined();
  });

  it("rewrites static resources on allowed CDNs to /proxy/asset and leaves others absolute", () => {
    const $ = $of(`<link rel="stylesheet" href="https://static.syosetu.com/view/css/a.css">
      <link rel="preload" href="/x.js" as="script"><img src="//4044.mitemin.net/i/x.png" srcset="/a.png 1x, https://ads.example/b.png 2x">
      <img src="https://ads.example/pixel.gif"><img src="data:image/gif;base64,AAAA">`);
    expect($("link").length).toBe(1);
    expect($("link").attr("href")).toBe("/proxy/asset?url=" + encodeURIComponent("https://static.syosetu.com/view/css/a.css"));
    const imgs = $("img");
    expect(imgs.eq(0).attr("src")).toBe("/proxy/asset?url=" + encodeURIComponent("https://4044.mitemin.net/i/x.png"));
    expect(imgs.eq(0).attr("srcset")).toBe(
      `/proxy/asset?url=${encodeURIComponent("https://yomou.syosetu.com/a.png")} 1x, https://ads.example/b.png 2x`,
    );
    expect(imgs.eq(1).attr("src")).toBe("https://ads.example/pixel.gif");
    expect(imgs.eq(2).attr("src")).toBe("data:image/gif;base64,AAAA");
  });

  it("keeps GET forms working and disables POST forms", () => {
    const $ = $of(`<form action="/search.php?x=1" method="get"><input name="q"></form>
      <form method="post" action="/login"><input name="p"></form>
      <form action="https://example.com/s"><input name="q"></form>`);
    const forms = $("form");
    expect(forms.eq(0).attr("action")).toBe("/proxy/narou/yomou.syosetu.com/search.php");
    expect(forms.eq(1).attr("action")).toBe(POST_DISABLED_PATH);
    expect(forms.eq(1).attr("method")).toBe("post");
    expect(forms.eq(2).attr("action")).toBe(POST_DISABLED_PATH);
  });

  it("uses <base href> for relative URL resolution", () => {
    const $ = $of(`<head><base href="https://ncode.syosetu.com/n1/"></head><a href="2/">n</a>`);
    expect($("a").attr("href")).toBe("/proxy/narou/ncode.syosetu.com/n1/2/");
  });

  it("rewrites url() in inline styles and style blocks", () => {
    const $ = $of(`<div style="background:url('https://static.syosetu.com/a.png')"></div><style>.a{background:url(/b.png)}</style>`);
    expect($("div").attr("style")).toContain("/proxy/asset?url=");
    expect($("style").text()).toContain("/proxy/asset?url=");
  });
});

describe("rewriteCss", () => {
  it("rewrites url() and @import against the CSS URL", () => {
    const out = rewriteCss(
      `@import "x.css"; a{background:url(../img/a.png)} b{background:url("https://ads.example/z.png")} c{background:url(data:image/png;base64,AA)}`,
      new URL("https://static.syosetu.com/view/css/a.css"),
    );
    expect(out).toContain(`@import "/proxy/asset?url=${encodeURIComponent("https://static.syosetu.com/view/css/x.css")}"`);
    expect(out).toContain(`url("/proxy/asset?url=${encodeURIComponent("https://static.syosetu.com/view/img/a.png")}")`);
    expect(out).toContain('url("https://ads.example/z.png")');
    expect(out).toContain('url("data:image/png;base64,AA")');
  });
});

describe("host whitelist", () => {
  it("accepts site hosts and known CDNs only", () => {
    for (const h of ["kakuyomu.jp", "cdn-static.kakuyomu.jp", "static.syosetu.com", "ncode.syosetu.com", "syosetu.org", "4044.mitemin.net"]) {
      expect(isAssetHost(h), h).toBe(true);
    }
    for (const h of ["example.com", "evil-mitemin.net", "mitemin.net.evil.com", "localhost", "127.0.0.1", "169.254.169.254", "kakuyomu.jp.evil.com", ""]) {
      expect(isAssetHost(h), h).toBe(false);
    }
  });

  it("parseAssetUrl rejects bad schemes, credentials, ports and foreign hosts", () => {
    expect(parseAssetUrl("https://static.syosetu.com/a.css")?.href).toBe("https://static.syosetu.com/a.css");
    expect(parseAssetUrl("http://static.syosetu.com/a.css")?.protocol).toBe("https:");
    for (const u of ["file:///etc/passwd", "https://example.com/a.png", "https://user:pw@static.syosetu.com/a", "https://static.syosetu.com:8080/a", "javascript:1", "", undefined, 5]) {
      expect(parseAssetUrl(u), String(u)).toBeNull();
    }
  });

  it("toProxyPagePath only maps site hosts", () => {
    expect(toProxyPagePath(new URL("https://kakuyomu.jp/works/1?a=b#c"))).toBe("/proxy/kakuyomu/kakuyomu.jp/works/1?a=b#c");
    expect(toProxyPagePath(new URL("https://static.syosetu.com/a.css"))).toBeNull();
    expect(toProxyPagePath(new URL("https://example.com/"))).toBeNull();
  });
});
