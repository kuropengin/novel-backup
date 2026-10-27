import * as cheerio from "cheerio";
import { isAllowedHost, siteForHost, type SiteId } from "../sites/index.js";

/**
 * ブラウズ用 Proxy の HTML/CSS/URL 書き換え (docs/04_sites_and_proxy.md)。
 * 純関数のみ。ネットワークには触れない。
 */

/**
 * 静的リソース(画像/CSS/フォント)として /proxy/asset・/proxy/img が取得してよい、
 * 3 サイトのホスト以外の CDN。`*.` 付きはサブドメイン全体(ドット境界で判定)。
 * 2026-10 に実ページで確認したもの:
 *  - なろう: static.syosetu.com (CSS/画像)、本文中の挿絵は *.mitemin.net (みてみん)
 *  - カクヨム: cdn-static.kakuyomu.jp
 *  - ハーメルン: 取得不能のため未確認。syosetu.org 配下のサブドメインのみ許可
 */
export const EXTRA_ASSET_HOSTS: readonly string[] = [
  "static.syosetu.com",
  "*.mitemin.net",
  "mitemin.net",
  "cdn-static.kakuyomu.jp",
  "*.syosetu.org",
];

function normHost(h: string): string {
  return h.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
}

/** 静的リソースの取得を許可するホストか。 */
export function isAssetHost(host: string): boolean {
  const h = normHost(host);
  if (!h || !/^[a-z0-9.-]+$/.test(h) || /^\d+(\.\d+){3}$/.test(h)) return false;
  if (siteForHost(h)) return true;
  for (const p of EXTRA_ASSET_HOSTS) {
    if (p.startsWith("*.")) {
      if (h.endsWith(p.slice(1))) return true;
    } else if (normHost(p) === h) return true;
  }
  return false;
}

/** /proxy/asset・/proxy/img に渡された URL を検証して URL にする。不可なら null。 */
export function parseAssetUrl(raw: unknown): URL | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 4096) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username || u.password || u.port) return null;
  if (!isAssetHost(u.hostname)) return null;
  u.protocol = "https:";
  u.hash = "";
  return u;
}

/** 元サイト URL → `/proxy/{site}/{host}/{path}?{query}#{hash}`。許可ホストでなければ null。 */
export function toProxyPagePath(url: URL, site?: SiteId): string | null {
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password || url.port) return null;
  const s = site && isAllowedHost(site, url.hostname) ? site : siteForHost(url.hostname);
  if (!s) return null;
  return `/proxy/${s}/${url.hostname.toLowerCase()}${url.pathname}${url.search}${url.hash}`;
}

/** 静的リソース URL → `/proxy/asset?url=...`。許可 CDN でなければ null。 */
export function toAssetPath(url: URL, kind: "asset" | "img" = "asset"): string | null {
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password || url.port || !isAssetHost(url.hostname)) return null;
  const u = new URL(url.href);
  u.hash = "";
  return `/proxy/${kind}?url=${encodeURIComponent(u.href)}`;
}

function resolveUrl(raw: string, base: URL): URL | null {
  try {
    return new URL(raw.trim(), base);
  } catch {
    return null;
  }
}

/** 静的リソースの参照を書き換える。許可 CDN でなければ絶対 URL のまま返す。 */
function rewriteResourceUrl(raw: string, base: URL): string {
  const t = raw.trim();
  if (!t || t.startsWith("data:") || t.startsWith("#")) return raw;
  const u = resolveUrl(t, base);
  if (!u) return raw;
  return toAssetPath(u) ?? u.href;
}

function rewriteSrcset(value: string, base: URL): string {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [u, ...desc] = part.split(/\s+/);
      return [rewriteResourceUrl(u!, base), ...desc].join(" ");
    })
    .join(", ");
}

/** CSS 内の `url(...)` と `@import "..."` を書き換える。 */
export function rewriteCss(css: string, base: URL): string {
  return css
    .replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s'"]*))\s*\)/gi, (_m, a?: string, b?: string, c?: string) => {
      const raw = a ?? b ?? c ?? "";
      return `url("${rewriteResourceUrl(raw, base).replace(/"/g, "%22")}")`;
    })
    .replace(/@import\s+(?:"([^"]*)"|'([^']*)')/gi, (_m, a?: string, b?: string) => {
      return `@import "${rewriteResourceUrl(a ?? b ?? "", base).replace(/"/g, "%22")}"`;
    });
}

/** POST フォームの action に差し替える無効化先(routes/proxy.ts が 405 を返す) */
export const POST_DISABLED_PATH = "/proxy/post-disabled";

const DROP_LINK_REL = /\b(preload|prefetch|modulepreload|preconnect|dns-prefetch|prerender)\b/i;
const INJECTED_STYLE = '<style data-nb-proxy>ins.adsbygoogle,[id^="google_ads"]{display:none!important}</style>';

/**
 * ページ HTML を書き換える。
 *  - script / iframe / object / embed / base / meta refresh / on* 属性を除去
 *  - a/form は許可ホストなら /proxy/{site}/{host}/... へ、許可外は新規タブで元 URL
 *  - 画像/CSS 等は許可 CDN なら /proxy/asset?url=...
 *  - POST フォームは無効化
 */
export function rewriteHtml(html: string, pageUrl: URL): string {
  const $ = cheerio.load(html, { scriptingEnabled: false });

  // <base href> があれば相対 URL の基準にする(要素自体は除去)
  let base = pageUrl;
  const baseHref = $("base[href]").first().attr("href");
  if (baseHref) base = resolveUrl(baseHref, pageUrl) ?? pageUrl;

  // <noscript> は展開(JS 無しで表示されるフォールバックを活かす)
  $("noscript").each((_i, el) => {
    $(el).replaceWith($(el).contents());
  });
  $("script, iframe, frame, frameset, object, embed, applet, base, template").remove();
  $("meta[http-equiv]").each((_i, el) => {
    if (/refresh/i.test($(el).attr("http-equiv") ?? "")) $(el).remove();
  });

  // on* 属性の除去 + style 属性内の url()
  $("*").each((_i, el) => {
    if (el.type !== "tag") return;
    for (const name of Object.keys(el.attribs)) {
      if (/^on/i.test(name)) $(el).removeAttr(name);
    }
    const style = el.attribs["style"];
    if (style && /url\(|@import/i.test(style)) $(el).attr("style", rewriteCss(style, base));
  });

  $("style").each((_i, el) => {
    const css = $(el).html();
    if (css) $(el).text(rewriteCss(css, base));
  });

  $("a[href], area[href]").each((_i, el) => {
    const t = $(el).attr("href")!.trim();
    if (!t || t.startsWith("#")) return;
    if (/^(javascript|vbscript|data):/i.test(t)) return void $(el).removeAttr("href");
    const u = resolveUrl(t, base);
    if (!u || (u.protocol !== "http:" && u.protocol !== "https:")) return; // mailto: など
    const p = toProxyPagePath(u);
    if (p) {
      $(el).attr("href", p);
      const target = ($(el).attr("target") ?? "").toLowerCase();
      if (target === "_blank" || target === "_top" || target === "_parent") $(el).removeAttr("target");
    } else {
      $(el).attr("href", u.href).attr("target", "_blank").attr("rel", "noopener noreferrer");
    }
  });

  $("form").each((_i, el) => {
    const method = ($(el).attr("method") ?? "get").toLowerCase();
    $(el).removeAttr("target");
    if (method !== "get") {
      $(el).attr("action", POST_DISABLED_PATH).attr("method", "post");
      return;
    }
    const action = $(el).attr("action");
    const u = resolveUrl(action && action.trim() ? action : base.href, base);
    const p = u && /^https?:$/.test(u.protocol) ? toProxyPagePath(u) : null;
    if (p) {
      // GET フォームは送信時に action のクエリが捨てられるため path のみにする
      $(el).attr("action", p.split("#")[0]!.split("?")[0]!);
    } else {
      // 許可外ホストへの送信は無効化
      $(el).attr("action", POST_DISABLED_PATH).attr("method", "post");
    }
  });

  $("link[href]").each((_i, el) => {
    const rel = $(el).attr("rel") ?? "";
    if (DROP_LINK_REL.test(rel) || $(el).attr("as") === "script") return void $(el).remove();
    $(el).attr("href", rewriteResourceUrl($(el).attr("href")!, base));
  });
  $("img, source, video, audio, track, input[type=image]").each((_i, el) => {
    const src = $(el).attr("src");
    if (src) $(el).attr("src", rewriteResourceUrl(src, base));
    const srcset = $(el).attr("srcset");
    if (srcset) $(el).attr("srcset", rewriteSrcset(srcset, base));
    const poster = $(el).attr("poster");
    if (poster) $(el).attr("poster", rewriteResourceUrl(poster, base));
  });
  $("[data-src]").each((_i, el) => {
    $(el).attr("data-src", rewriteResourceUrl($(el).attr("data-src")!, base));
  });

  if ($("head").length) $("head").append(INJECTED_STYLE);
  return $.html();
}

/** 失敗時にブラウズ画面(iframe)へ表示するエラー HTML。 */
export function errorPageHtml(title: string, message: string): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>body{font-family:system-ui,sans-serif;margin:0;padding:24px;line-height:1.7;color:#232629;background:#fff}
@media(prefers-color-scheme:dark){body{background:#1f2326;color:#e4e7e9}}
h1{font-size:18px}.box{max-width:560px;margin:10vh auto;padding:20px;border:1px solid #b3261e;border-radius:10px}</style></head>
<body><div class="box"><h1>${esc(title)}</h1><p>${esc(message)}</p></div></body></html>`;
}
