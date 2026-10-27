import { Router, type Response } from "express";
import { ah } from "../http/errors.js";
import { politeFetch, type PoliteFetchResult } from "../http/politeFetch.js";
import { errorPageHtml, parseAssetUrl, rewriteCss, rewriteHtml } from "../proxy/rewrite.js";
import { isAllowedHost, isSiteId, SiteBlockedError, SiteNotFoundError, siteForHost } from "../sites/index.js";

/** プロキシ応答に共通で付けるヘッダ。Set-Cookie 等の元ヘッダは転送しない。 */
const CSP_PAGE = "script-src 'none'; object-src 'none'; frame-ancestors 'self'";
const CSP_ASSET = "script-src 'none'; object-src 'none'; sandbox";
const MAX_BYTES = 25 * 1024 * 1024;

type Fetcher = (url: string, opts?: Parameters<typeof politeFetch>[1]) => Promise<PoliteFetchResult>;

export interface ProxyDeps {
  fetcher?: Fetcher;
}

function baseHeaders(res: Response) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
}

function plain(res: Response, status: number, text: string) {
  baseHeaders(res);
  res.status(status).type("text/plain; charset=utf-8").send(text);
}

function contentTypeOf(r: PoliteFetchResult): string {
  return (r.headers.get("content-type") ?? "application/octet-stream").trim();
}

function isScriptType(ct: string): boolean {
  return /javascript|ecmascript|x-shockwave|wasm|html|xml/i.test(ct.split(";")[0]!) && !/^image\/svg/i.test(ct);
}

function upstreamError(res: Response, e: unknown, html: boolean) {
  baseHeaders(res);
  let status = 502;
  let title = "取得できませんでした";
  let msg = "サイトからの取得に失敗しました。時間をおいて再度お試しください。";
  if (e instanceof SiteNotFoundError) {
    status = 404;
    title = "ページが見つかりません";
    msg = "サイト上にこのページは存在しません(404)。";
  } else if (e instanceof SiteBlockedError) {
    title = "サイトにブロックされました";
    msg =
      e.reason === "challenge"
        ? "このサイトはボット対策(Cloudflare 等)により、サーバーからのアクセスを拒否しています。ブラウズ・リーダー表示・バックアップは利用できません。"
        : e.reason === "age-gate"
          ? "年齢確認ページのため取得できませんでした。"
          : "サイトから取得をブロックされました。";
    res.setHeader("X-NB-Error", "site_blocked");
  } else {
    console.error("[proxy] upstream error:", e instanceof Error ? e.message : e);
  }
  if (html) {
    res.setHeader("Content-Security-Policy", CSP_PAGE);
    res.setHeader("Cache-Control", "no-store");
    res.status(status).type("text/html; charset=utf-8").send(errorPageHtml(title, msg));
  } else {
    res.status(status).type("text/plain; charset=utf-8").send(title);
  }
}

/** 静的リソース(/proxy/asset, /proxy/img)。kind=img は image/* のみ。 */
function assetHandler(kind: "asset" | "img", fetcher: Fetcher) {
  return ah(async (req, res) => {
    const target = parseAssetUrl(req.query.url);
    if (!target) return plain(res, 400, "bad request: url is not allowed");
    let r: PoliteFetchResult;
    try {
      r = await fetcher(target.href, {
        priority: "interactive",
        binary: true,
        maxRetries: 1,
        headers: { Accept: kind === "img" ? "image/*,*/*;q=0.5" : "*/*" },
      });
    } catch (e) {
      return upstreamError(res, e, false);
    }
    // リダイレクト先も許可リスト内であること
    if (!parseAssetUrl(r.url)) return plain(res, 502, "redirected to a disallowed host");
    const body = r.body ?? Buffer.alloc(0);
    if (body.length > MAX_BYTES) return plain(res, 502, "too large");
    const ct = contentTypeOf(r);
    if (kind === "img" && !/^image\//i.test(ct)) return plain(res, 415, "not an image");
    if (isScriptType(ct)) return plain(res, 415, "unsupported content type");

    baseHeaders(res);
    res.setHeader("Content-Security-Policy", CSP_ASSET);
    res.setHeader("Cache-Control", "private, max-age=86400");
    if (/^text\/css/i.test(ct)) {
      const css = rewriteCss(body.toString("utf8"), new URL(r.url));
      return void res.status(200).type("text/css; charset=utf-8").send(css);
    }
    res.status(200).type(ct).send(body);
  });
}

export function proxyRouter(deps: ProxyDeps = {}): Router {
  const fetcher: Fetcher = deps.fetcher ?? politeFetch;
  const router = Router();

  // 認証必須(未ログインは 401 プレーンテキスト)
  router.use((req, res, next) => {
    if (!req.user) return plain(res, 401, "unauthorized");
    next();
  });

  // POST 無効化先(書き換え済みフォームの送信先)・GET 以外は一律 405
  router.use((req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD") return next();
    res.setHeader("Allow", "GET, HEAD");
    plain(res, 405, "このProxyでは GET 以外のリクエストは利用できません");
  });
  router.get("/post-disabled", (_req, res) => plain(res, 405, "このProxyではフォームの POST 送信は利用できません"));

  router.get("/asset", assetHandler("asset", fetcher));
  router.get("/img", assetHandler("img", fetcher));

  // /proxy/{site}/{host}/{path}?{query}
  router.get(
    /^\/([^/?]+)\/([^/?]+)(\/[^?]*)?(\?.*)?$/,
    ah(async (req, res) => {
      const [site, host, path = "/", query = ""] = req.url.match(/^\/([^/?]+)\/([^/?]+)(\/[^?]*)?(\?.*)?$/)!.slice(1) as [
        string,
        string,
        string | undefined,
        string | undefined,
      ];
      const h = host.toLowerCase();
      if (!isSiteId(site) || !isAllowedHost(site, h)) return plain(res, 400, "bad request: host is not allowed");
      let target: URL;
      try {
        target = new URL(`https://${h}${path || "/"}${query ?? ""}`);
      } catch {
        return plain(res, 400, "bad request: invalid url");
      }
      if (target.hostname !== h.replace(/^www\./, "") && target.hostname !== h) return plain(res, 400, "bad request");

      let r: PoliteFetchResult;
      try {
        r = await fetcher(target.href, { priority: "interactive", binary: true, maxRetries: 2 });
      } catch (e) {
        return upstreamError(res, e, true);
      }
      let finalUrl: URL;
      try {
        finalUrl = new URL(r.url);
      } catch {
        finalUrl = target;
      }
      // リダイレクト先が許可ホスト(いずれかのサイト)でなければ返さない
      if (!siteForHost(finalUrl.hostname)) return plain(res, 502, "redirected to a disallowed host");
      const body = r.body ?? Buffer.alloc(0);
      if (body.length > MAX_BYTES) return plain(res, 502, "too large");
      const ct = contentTypeOf(r);

      baseHeaders(res);
      res.setHeader("Content-Security-Policy", CSP_PAGE);
      if (/^(text\/html|application\/xhtml\+xml)/i.test(ct)) {
        res.setHeader("Cache-Control", "private, no-store");
        const html = rewriteHtml(body.toString("utf8"), finalUrl);
        return void res.status(200).type("text/html; charset=utf-8").send(html);
      }
      if (/^text\/css/i.test(ct)) {
        res.setHeader("Cache-Control", "private, max-age=3600");
        return void res.status(200).type("text/css; charset=utf-8").send(rewriteCss(body.toString("utf8"), finalUrl));
      }
      if (isScriptType(ct)) return plain(res, 415, "unsupported content type");
      res.setHeader("Cache-Control", "private, max-age=3600");
      res.setHeader("Content-Security-Policy", CSP_ASSET);
      res.status(200).type(ct).send(body);
    }),
  );

  router.use((_req, res) => plain(res, 400, "bad request"));
  return router;
}
