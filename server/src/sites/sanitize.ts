import * as cheerio from "cheerio";
import sanitize from "sanitize-html";

const ALLOWED_TAGS = [
  "p", "br", "ruby", "rb", "rt", "rp", "span", "em", "strong", "b", "i", "u", "s", "small", "sub", "sup",
  "hr", "div", "img", "a", "h1", "h2", "h3", "h4", "h5", "h6",
];

function absolutize(value: string | undefined, baseUrl?: string): string | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (!v) return undefined;
  try {
    const u = baseUrl ? new URL(v, baseUrl) : new URL(v);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 本文 HTML のサニタイズ。img src / a href は baseUrl で絶対 URL 化する(/proxy/img には書き換えない)。
 * id 属性は除去。span は class のみ残す。
 */
export function sanitizeBody(html: string, baseUrl?: string): string {
  const out = sanitize(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {
      img: ["src", "alt", "width", "height"],
      a: ["href"],
      span: ["class"],
    },
    allowedSchemes: ["http", "https"],
    allowProtocolRelative: true,
    transformTags: {
      img: (tagName, attribs) => {
        // 遅延読込属性があれば優先
        const src = absolutize(attribs["data-src"] || attribs.src, baseUrl);
        const next: Record<string, string> = { ...attribs };
        delete next["data-src"];
        if (src) next.src = src;
        else delete next.src;
        return { tagName, attribs: next };
      },
      a: (tagName, attribs) => {
        const href = absolutize(attribs.href, baseUrl);
        const next: Record<string, string> = {};
        if (href) next.href = href;
        return { tagName, attribs: next };
      },
    },
    exclusiveFilter: (frame) => frame.tag === "img" && !frame.attribs.src,
  });
  return out.trim();
}

/** サニタイズ済み(または任意)HTML → プレーンテキスト。br/p を改行に。 */
export function htmlToText(html: string): string {
  const $ = cheerio.load(`<div id="__root">${html}</div>`, null, false);
  const root = $("#__root");
  root.find("br").replaceWith("\n");
  root.find("rt, rp").remove();
  root.find("p, div, h1, h2, h3, h4, h5, h6, hr").each((_, el) => {
    $(el).append("\n");
  });
  return root.text().replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
}

/** 要素内のテキスト(br を改行に)。あらすじ等のプレーンテキスト化用。 */
export function elementToText($: cheerio.CheerioAPI, el: cheerio.Cheerio<any>): string {
  const clone = el.clone();
  clone.find("br").replaceWith("\n");
  return clone.text().replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").trim();
}

/** 本文ブロックが実質空(空白・br のみ)か */
export function isBlankHtml(html: string | undefined): boolean {
  if (!html) return true;
  return htmlToText(html).replace(/[\s　]/g, "") === "" && !/<img/i.test(html);
}
