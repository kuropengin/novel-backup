/**
 * ブラウザで保存したハーメルンの HTML をパーサーに通して結果を表示する(ネットワーク不使用)。
 * 使い方:
 *   npx tsx server/scripts/parse-hameln-file.ts novel   <作品ページ.html> <作品ID>
 *   npx tsx server/scripts/parse-hameln-file.ts episode <話ページ.html>   <作品ID> <話番号>
 * 保存方法: ブラウザでページを開き Ctrl+S →「ウェブページ、HTMLのみ」で保存。
 */
import fs from "node:fs";
import { htmlToText } from "../src/sites/index.js";
import { parseHamelnEpisode, parseHamelnNovelPage } from "../src/sites/hameln.js";

const [mode, file, novelId, ep] = process.argv.slice(2);
if (!mode || !file || !novelId || (mode === "episode" && !ep)) {
  console.error("usage: parse-hameln-file.ts novel <file> <id> | episode <file> <id> <n>");
  process.exit(2);
}
const html = fs.readFileSync(file, "utf8");
console.log(`input: ${html.length} chars, title=${/<title>([^<]*)/i.exec(html)?.[1] ?? "(none)"}`);

if (mode === "novel") {
  const info = parseHamelnNovelPage(html, novelId);
  console.log({ title: info.title, author: info.author, status: info.status, short: info.isShortStory, tags: info.tags, synopsis: info.synopsis.slice(0, 120) });
  console.log(`episodes: ${info.episodes.length}`);
  for (const e of [...info.episodes.slice(0, 3), ...info.episodes.slice(-2)]) {
    console.log(`  #${e.index} [${e.episodeKey}] ${e.title} (章: ${e.chapter ?? "-"}) pub=${e.publishedAt ?? "-"} upd=${e.updatedAt ?? "-"}`);
  }
} else {
  const c = parseHamelnEpisode(html, ep, `https://syosetu.org/novel/${novelId}/${ep}.html`);
  console.log({ title: c.title, preface: !!c.prefaceHtml, afterword: !!c.afterwordHtml, bodyChars: c.bodyHtml.length });
  console.log(htmlToText(c.bodyHtml).slice(0, 300));
}
