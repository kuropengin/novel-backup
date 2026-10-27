/**
 * InAppBrowser のページ内に注入するスクリプト。
 * 利用者が ★ を押したときだけ、表示中のページの DOM から作品タイトル等を読み取ってアプリへ通知する。
 * 自動取得は行わない。関数は文字列化して注入されるため、外部の変数・import を参照してはならない。
 */
export interface PagePayload {
  type: "nb-save";
  url: string;
  title: string;
  author: string;
}

export function pageScript(): void {
  const w = window as unknown as Record<string, unknown>;
  if (w.__nbStar || document.getElementById("nb-star")) return; // 再注入しない
  w.__nbStar = 1;

  const host = location.hostname;
  const site = /(^|\.)syosetu\.org$/.test(host)
    ? "hameln"
    : /(^|\.)syosetu\.com$/.test(host)
      ? "narou"
      : /(^|\.)kakuyomu\.jp$/.test(host)
        ? "kakuyomu"
        : "";
  if (!site) return; // 3 サイト以外(広告・外部リンク等)では出さない

  const text = (sel: string, root?: ParentNode): string => {
    const el = (root || document).querySelector(sel);
    return el && el.textContent ? el.textContent.replace(/\s+/g, " ").trim() : "";
  };
  const first = (sels: string[]): string => {
    for (let i = 0; i < sels.length; i++) {
      const t = text(sels[i]!);
      if (t) return t;
    }
    return "";
  };
  const dt = (document.title || "").trim();

  function titleNarou(): string {
    const m = /^\/(n\w+)\/(\d+)\/?$/.exec(location.pathname);
    if (m) {
      // 話ページ: .p-novel__title は話タイトル。作品名はパンくずの作品リンク、無ければ document.title の前半
      const links = document.querySelectorAll('a[href="/' + m[1] + '/"], a[href$="syosetu.com/' + m[1] + '/"]');
      for (let i = 0; i < links.length; i++) {
        const t = (links[i]!.textContent || "").replace(/\s+/g, " ").trim();
        if (t && t !== "目次") return t;
      }
      const ep = first([".p-novel__title", "h1"]);
      if (ep && dt.slice(-ep.length - 3) === " - " + ep) return dt.slice(0, dt.length - ep.length - 3);
      return dt.split(" - ")[0] || dt;
    }
    return first([".p-novel__title", ".novel_title", "h1"]) || dt;
  }
  function titleKakuyomu(): string {
    const t = first(["#contentMain-header-workTitle", 'h1 a[href^="/works/"]', "h1"]);
    if (t) return t;
    const parts = dt.replace(/\s*-\s*カクヨム.*$/, "").split(" - ");
    return (parts[parts.length - 1] || dt).replace(/（[^（）]*）$/, "").trim();
  }
  function titleHameln(): string {
    // 実 DOM 未検証(推測セレクタ)。取れなければ document.title から " - ハーメルン" を除去した前半
    const t = first(['span[itemprop="name"]', ".ss span[style*='font-size:120%']", "h1"]);
    const m = /^\/novel\/(\d+)\/\d+\.html$/.exec(location.pathname);
    if (m) {
      // 話ページ(推測): 作品ページへのリンクのテキストを作品名とみなす
      const links = document.querySelectorAll('a[href="/novel/' + m[1] + '/"]');
      for (let i = 0; i < links.length; i++) {
        const lt = (links[i]!.textContent || "").replace(/\s+/g, " ").trim();
        if (lt && lt !== "目次") return lt;
      }
    }
    if (t) return t;
    const base = dt.replace(/\s*[-－|]\s*ハーメルン.*$/, "");
    return base.split(" - ")[0] || base;
  }
  function authorOf(): string {
    if (site === "narou") return text(".p-novel__author a") || text(".p-novel__author").replace(/^作者[:：]\s*/, "");
    if (site === "hameln") return first(['span[itemprop="author"] a', 'span[itemprop="author"]']);
    const m = /（([^（）]*)）\s*-\s*カクヨム/.exec(dt);
    return text('a[href^="/users/"]') || (m ? m[1]! : "");
  }

  const toast = (msg: string, kind?: string) => {
    let t = document.getElementById("nb-toast");
    if (!t) {
      t = document.createElement("div");
      t.id = "nb-toast";
      t.style.cssText =
        "position:fixed;left:50%;bottom:90px;transform:translateX(-50%);max-width:80%;padding:10px 16px;border-radius:8px;" +
        "color:#fff;font:14px/1.4 sans-serif;z-index:2147483647;text-align:center;pointer-events:none;";
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.setAttribute("data-kind", kind === "error" ? "error" : "ok"); // テーマ CSS(starCss)が配色
    t.style.background = kind === "error" ? "#b3261e" : "#2b6b47";
    t.style.display = "block";
    const timer = w.__nbToastTimer as number | undefined;
    if (timer) clearTimeout(timer);
    w.__nbToastTimer = setTimeout(() => {
      t!.style.display = "none";
    }, 3000);
  };
  w.__nbToast = toast;

  const btn = document.createElement("div");
  btn.id = "nb-star";
  btn.textContent = "★";
  btn.setAttribute("role", "button");
  btn.style.cssText =
    "position:fixed;right:16px;bottom:24px;width:48px;height:48px;border-radius:50%;background:#f5b301;color:#fff;" +
    "font:26px/48px sans-serif;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.4);z-index:2147483647;opacity:.85;" +
    "user-select:none;-webkit-user-select:none;cursor:pointer;";
  btn.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    try {
      const title = (site === "narou" ? titleNarou() : site === "kakuyomu" ? titleKakuyomu() : titleHameln()) || dt || host;
      const payload = { type: "nb-save", url: location.href, title: title.slice(0, 500), author: authorOf().slice(0, 200) };
      const bridge = (w.webkit as { messageHandlers?: { cordova_iab?: { postMessage(s: string): void } } } | undefined)?.messageHandlers
        ?.cordova_iab;
      if (!bridge) throw new Error("no bridge");
      bridge.postMessage(JSON.stringify(payload));
    } catch {
      toast("アプリへ送信できませんでした", "error");
    }
  });
  document.body.appendChild(btn);
}

/** 注入用のコード文字列(即時実行)。 */
export function pageScriptCode(): string {
  return `(${pageScript.toString()})();`;
}

/** ページ内トーストを表示するコード。 */
export function toastCode(message: string, kind: "ok" | "error"): string {
  return `window.__nbToast&&window.__nbToast(${JSON.stringify(message)},${JSON.stringify(kind)});`;
}
