/**
 * 使い方: npx tsx server/scripts/try-adapter.ts <作品URL or 話URL>
 * NovelInfo の要約と、(指定があればその話 / なければ)最初の話のタイトルと本文先頭を表示する。
 */
import { configurePoliteFetch } from "../src/http/politeFetch.js";
import { getAdapter, htmlToText, resolveUrl } from "../src/sites/index.js";

process.on("uncaughtException", (e) => {
  console.error(`${e.name}: ${e.message}`);
  process.exit(1);
});

const arg = process.argv[2];
if (!arg) {
  console.error("usage: tsx server/scripts/try-adapter.ts <url>");
  process.exit(2);
}
const resolved = resolveUrl(arg);
if (!resolved) {
  console.error("作品/話ページとして解決できない URL:", arg);
  process.exit(2);
}
configurePoliteFetch({ getIntervalMs: () => 1500 });
const adapter = getAdapter(resolved.site);
const info = await adapter.fetchNovel(resolved.novelKey, { priority: "interactive" });

const fmt = (e: (typeof info.episodes)[number]) =>
  `  #${e.index} [${e.episodeKey}] ${e.title}${e.chapter ? `  (章: ${e.chapter})` : ""}  pub=${e.publishedAt ?? "-"} upd=${e.updatedAt ?? "-"}`;

console.log(`site      : ${info.site} (${adapter.displayName})`);
console.log(`novelKey  : ${info.novelKey}`);
console.log(`title     : ${info.title}`);
console.log(`author    : ${info.author}${info.authorUrl ? ` <${info.authorUrl}>` : ""}`);
console.log(`status    : ${info.status}   short=${info.isShortStory}`);
console.log(`tags      : ${info.tags.join(", ")}`);
console.log(`synopsis  : ${info.synopsis.slice(0, 120).replace(/\n/g, " / ")}`);
console.log(`episodes  : ${info.episodes.length}`);
info.episodes.slice(0, 3).forEach((e) => console.log(fmt(e)));
if (info.episodes.length > 6) console.log("  ...");
info.episodes.slice(Math.max(3, info.episodes.length - 3)).forEach((e) => console.log(fmt(e)));

const key = resolved.episodeKey ?? info.episodes[0]?.episodeKey;
if (key) {
  const ep = await adapter.fetchEpisode(resolved.novelKey, key, { priority: "interactive" });
  console.log(`\n--- episode ${key}: ${ep.title}`);
  if (ep.prefaceHtml) console.log(`[前書き] ${htmlToText(ep.prefaceHtml).slice(0, 100).replace(/\n/g, " / ")}`);
  console.log(htmlToText(ep.bodyHtml).slice(0, 300));
  if (ep.afterwordHtml) console.log(`[後書き] ${htmlToText(ep.afterwordHtml).slice(0, 100).replace(/\n/g, " / ")}`);
}
