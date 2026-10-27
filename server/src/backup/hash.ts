import { createHash } from "node:crypto";
import type { EpisodeContent, NovelInfo, TocEntry } from "../sites/types.js";

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** 改行コードと前後空白を統一する(ハッシュ用)。 */
export function normalizeText(s: string | undefined | null): string {
  return (s ?? "").replace(/\r\n?/g, "\n").trim();
}

/** 話の内容ハッシュ: sha256(正規化した title + preface + body + afterword)。 */
export function episodeContentHash(c: Pick<EpisodeContent, "title" | "prefaceHtml" | "bodyHtml" | "afterwordHtml">): string {
  return sha256(
    JSON.stringify([normalizeText(c.title), normalizeText(c.prefaceHtml), normalizeText(c.bodyHtml), normalizeText(c.afterwordHtml)]),
  );
}

/** 作品メタ(目次を除く)。取得のたびに変わりうるフィールドは含めない。 */
export function pickMeta(info: NovelInfo) {
  return {
    site: info.site,
    novelKey: info.novelKey,
    url: info.url,
    title: info.title,
    author: info.author,
    authorUrl: info.authorUrl ?? null,
    synopsis: normalizeText(info.synopsis),
    tags: [...info.tags],
    status: info.status,
    isShortStory: info.isShortStory,
  };
}

export function pickToc(episodes: TocEntry[]) {
  return episodes.map((e) => ({
    episodeKey: e.episodeKey,
    index: e.index,
    title: e.title,
    chapter: e.chapter ?? null,
    publishedAt: e.publishedAt ?? null,
    updatedAt: e.updatedAt ?? null,
  }));
}

/** メタ版のハッシュ: sha256(JSON(meta) + JSON(toc))。 */
export function metaHash(info: NovelInfo): string {
  return sha256(JSON.stringify(pickMeta(info)) + JSON.stringify(pickToc(info.episodes)));
}
