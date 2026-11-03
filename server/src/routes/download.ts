import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import { ah } from "../http/errors.js";
import { DOWNLOAD_PAGE_CSP } from "../http/security.js";

export const APK_FILE_NAME = "novel-backup.apk";

/** Android アプリ(APK)の公開ダウンロード。認証不要。APK は npm run mobile:apk が <dataDir>/apk/ へ配置する */
export function downloadRouter(apkDir: string): Router {
  const router = Router();
  const apkPath = path.join(apkDir, APK_FILE_NAME);

  function stat(): fs.Stats | null {
    try {
      return fs.statSync(apkPath);
    } catch {
      return null;
    }
  }

  // SHA-256 は mtime+サイズをキーにキャッシュ(APK 差し替え時だけ再計算)
  let shaCache: { key: string; sha: string } | null = null;
  async function sha256(s: fs.Stats): Promise<string> {
    const key = `${s.mtimeMs}:${s.size}`;
    if (shaCache?.key === key) return shaCache.sha;
    const hash = crypto.createHash("sha256");
    for await (const chunk of fs.createReadStream(apkPath)) hash.update(chunk as Buffer);
    shaCache = { key, sha: hash.digest("hex") };
    return shaCache.sha;
  }

  router.get("/", ah(async (req, res) => {
    const s = stat();
    const sha = s ? await sha256(s).catch(() => null) : null;
    const body = s
      ? `<p><a class="btn" href="${req.baseUrl}/${APK_FILE_NAME}">APK をダウンロード</a></p>
<p class="meta">ビルド: ${s.mtime.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })} / ${(s.size / 1024 / 1024).toFixed(1)} MB</p>
${sha ? `<p class="meta">SHA-256:<br><code>${sha}</code></p>` : ""}
<ol>
<li>ダウンロードした APK をタップしてインストールします。</li>
<li>初回は「提供元不明のアプリ」のインストールを、ブラウザに対して許可してください。</li>
<li>アプリの設定でサーバー URL にこのサイトのアドレスを入力します。</li>
</ol>`
      : `<p>APK はまだ配置されていません。</p>`;
    res.setHeader("Content-Security-Policy", DOWNLOAD_PAGE_CSP);
    res.type("html").send(`<!DOCTYPE html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>小説ビューア ダウンロード</title>
<style>
body{font:16px/1.6 system-ui,sans-serif;max-width:480px;margin:40px auto;padding:0 16px;background:#16181c;color:#e7e9ea}
.btn{display:inline-block;padding:12px 24px;border-radius:999px;background:#1d9bf0;color:#fff;font-weight:700;text-decoration:none}
.meta{color:#8b98a5;font-size:14px}
code{word-break:break-all;font-size:12px}
</style></head>
<body><h1>小説ビューア</h1>${body}</body></html>`);
  }));

  router.get(`/${APK_FILE_NAME}`, (_req, res) => {
    if (!stat()) return void res.status(404).json({ error: "not_found" });
    res.type("application/vnd.android.package-archive");
    res.setHeader("Cache-Control", "no-cache");
    res.download(apkPath, APK_FILE_NAME);
  });

  return router;
}
