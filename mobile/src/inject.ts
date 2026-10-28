/**
 * SiteView.evaluate で表示中ページに対して実行する、ページ情報の取得コード。
 * ★ の保存や閲覧履歴の送信のときに、表示中ページの DOM から作品名・話タイトル等を読み取るだけ(自動取得は行わない)。
 * 関数は文字列化して実行されるため、外部の変数・import を参照してはならない。
 */
export interface PageInfo {
  url: string;
  novelTitle: string;
  /** 話ページのときのみ。作品ページ等では空 */
  episodeTitle: string;
  author: string;
}

export function extractPageInfo(): PageInfo {
  const host = location.hostname;
  const site = /(^|\.)syosetu\.org$/.test(host)
    ? "hameln"
    : /(^|\.)syosetu\.com$/.test(host)
      ? "narou"
      : /(^|\.)kakuyomu\.jp$/.test(host)
        ? "kakuyomu"
        : "";
  const out: PageInfo = { url: location.href, novelTitle: "", episodeTitle: "", author: "" };
  if (!site) return out; // 3 サイト以外では何も読まない

  const clean = (s: string | null | undefined): string => (s || "").replace(/\s+/g, " ").trim();
  const text = (sel: string): string => {
    const el = document.querySelector(sel);
    return el ? clean(el.textContent) : "";
  };
  const first = (sels: string[]): string => {
    for (let i = 0; i < sels.length; i++) {
      const t = text(sels[i]!);
      if (t) return t;
    }
    return "";
  };
  const dt = clean(document.title);

  function narou(): void {
    const m = /^\/(n\w+)\/(\d+)\/?$/.exec(location.pathname);
    if (m) {
      // 話ページ: .p-novel__title が話タイトル。作品名はパンくずの作品リンク、無ければ document.title の前半
      const ep = first([".p-novel__title", "h1"]);
      out.episodeTitle = ep;
      const links = document.querySelectorAll('a[href="/' + m[1] + '/"], a[href$="syosetu.com/' + m[1] + '/"]');
      for (let i = 0; i < links.length; i++) {
        const t = clean(links[i]!.textContent);
        if (t && t !== "目次") {
          out.novelTitle = t;
          break;
        }
      }
      if (!out.novelTitle) {
        out.novelTitle = ep && dt.slice(-ep.length - 3) === " - " + ep ? dt.slice(0, dt.length - ep.length - 3) : dt.split(" - ")[0] || dt;
      }
    } else {
      out.novelTitle = first([".p-novel__title", ".novel_title", "h1"]) || dt;
    }
    out.author = text(".p-novel__author a") || text(".p-novel__author").replace(/^作者[:：]\s*/, "");
  }

  function kakuyomu(): void {
    if (/^\/works\/\d+\/episodes\/\d+/.test(location.pathname)) out.episodeTitle = first([".widget-episodeTitle", "h1"]);
    let t = first(["#contentMain-header-workTitle", 'h1 a[href^="/works/"]']);
    if (!t && !out.episodeTitle) t = first(["h1"]);
    if (!t) {
      const parts = dt.replace(/\s*-\s*カクヨム.*$/, "").split(" - ");
      t = clean((parts[parts.length - 1] || dt).replace(/（[^（）]*）$/, ""));
    }
    out.novelTitle = t;
    const m = /（([^（）]*)）\s*-\s*カクヨム/.exec(dt);
    out.author = text('a[href^="/users/"]') || (m ? m[1]! : "");
  }

  function hameln(): void {
    // 実 DOM 未検証(推測セレクタ)。取れなければ document.title(「作品名 - 話名 - ハーメルン」想定)を分解
    const base = dt.replace(/\s*[-－|]\s*ハーメルン.*$/, "");
    const parts = base.split(" - ");
    const m = /^\/novel\/(\d+)\/\d+\.html$/.exec(location.pathname);
    if (m) {
      const links = document.querySelectorAll('a[href="/novel/' + m[1] + '/"]');
      for (let i = 0; i < links.length; i++) {
        const lt = clean(links[i]!.textContent);
        if (lt && lt !== "目次") {
          out.novelTitle = lt;
          break;
        }
      }
      if (!out.novelTitle) out.novelTitle = first(['span[itemprop="name"]']) || parts[0] || base;
      out.episodeTitle = first(["#honbun_title", ".ss span[style*='font-size']"]) || (parts.length > 1 ? parts[parts.length - 1]! : "");
    } else {
      out.novelTitle = first(['span[itemprop="name"]', ".ss span[style*='font-size:120%']", "h1"]) || parts[0] || base;
    }
    out.author = first(['span[itemprop="author"] a', 'span[itemprop="author"]']);
  }

  try {
    if (site === "narou") narou();
    else if (site === "kakuyomu") kakuyomu();
    else hameln();
  } catch (e) {
    /* 取得失敗時は document.title で補う */
  }
  if (!out.novelTitle) out.novelTitle = dt || host;
  out.novelTitle = out.novelTitle.slice(0, 500);
  out.episodeTitle = out.episodeTitle.slice(0, 500);
  out.author = out.author.slice(0, 200);
  return out;
}

/**
 * SiteView.evaluate に渡すコード。式の値は PageInfo のオブジェクト(result は JSON 文字列)。
 * 例: `const info = await evaluateJson<PageInfo>(pageInfoCode())`
 */
export function pageInfoCode(): string {
  return `(${extractPageInfo.toString()})()`;
}
