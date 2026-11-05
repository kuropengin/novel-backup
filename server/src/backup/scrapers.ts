/** Python Scrapling ブリッジ経由のスクレイパー実装 */

import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { normalizeSourceDate } from "./dates.js";
import { resolveScraperPython } from "./pythonUpdater.js";
import { Episode, EpisodeContent, NovelMetadata, SiteId } from "./types.js";

type PythonOperation = "metadata" | "episodes" | "content";

interface PythonResponse<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

interface PythonEpisode {
  episode_key: string;
  position: number;
  title: string;
  chapter?: string | null;
  published_at: string;
  updated_at: string;
}

interface ScraperOptions {
  pythonBin?: string;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const pythonScript = path.resolve(here, "../../python/scrape_with_scrapling.py");

/** Python ブリッジ 1 回の呼び出しの上限時間 */
const PYTHON_TIMEOUT_MS = 120_000;
/** 話一覧は目次を複数ページ辿ることがあるため長めにする */
const PYTHON_EPISODES_TIMEOUT_MS = 600_000;

function parseJsonFromStdout<T>(stdout: string): PythonResponse<T> {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.startsWith("{") || !line.endsWith("}")) continue;
    try {
      return JSON.parse(line) as PythonResponse<T>;
    } catch {
      continue;
    }
  }
  throw new Error(`Python returned non-JSON output: ${stdout.slice(0, 300)}`);
}

async function runPython<T>(
  pythonBin: string,
  site: SiteId,
  novelKey: string,
  operation: PythonOperation,
  episodeKey?: string
): Promise<T> {
  const args = ["-X", "utf8", pythonScript, "--site", site, "--novel-key", novelKey, "--operation", operation];
  if (episodeKey) args.push("--episode-key", episodeKey);

  // 自動更新された overlay(venv)があればその python を使う。spawn 毎に解決するので切り替え中でも安全
  const child = spawn(resolveScraperPython(pythonBin), args, {
    cwd: path.resolve(here, "../.."),
    env: { ...process.env, PYTHONUTF8: "1" },
    windowsHide: true,
  });

  let stdout = "";
  let stderr = "";
  // setEncoding でチャンク境界をまたぐマルチバイト文字の分断(文字化け)を防ぐ
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  // 応答しない Python が残り続けないよう、一定時間で強制終了して reject する
  const timeoutMs = operation === "episodes" ? PYTHON_EPISODES_TIMEOUT_MS : PYTHON_TIMEOUT_MS;
  const exitCode = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`[Scrapling] timeout after ${timeoutMs / 1000}s (${operation} ${site}/${novelKey})`));
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });

  const parsed = parseJsonFromStdout<T>(stdout);
  if (!parsed.ok || exitCode !== 0 || !parsed.data) {
    const errorMessage = parsed.error || stderr || `python exited with code ${exitCode}`;
    throw new Error(`[Scrapling] ${errorMessage}`);
  }
  return parsed.data;
}

export abstract class BaseScraper {
  constructor(protected readonly site: SiteId) {}
  abstract scrapeMetadata(novelKey: string): Promise<NovelMetadata>;
  abstract scrapeEpisodeList(novelKey: string): Promise<Episode[]>;
  abstract scrapeEpisodeContent(novelKey: string, episodeKey: string): Promise<EpisodeContent>;
}

export class PythonScraplingScraper extends BaseScraper {
  constructor(site: SiteId, private readonly pythonBin: string) {
    super(site);
  }

  async scrapeMetadata(novelKey: string): Promise<NovelMetadata> {
    return runPython<NovelMetadata>(this.pythonBin, this.site, novelKey, "metadata");
  }

  async scrapeEpisodeList(novelKey: string): Promise<Episode[]> {
    const rows = await runPython<PythonEpisode[]>(this.pythonBin, this.site, novelKey, "episodes");
    return rows.map((row) => ({
      episodeKey: row.episode_key,
      position: row.position,
      title: row.title,
      chapter: row.chapter || undefined,
      // サイト表記の日時は ISO 8601 (UTC) へ正規化。取得できなければ空文字
      publishedAt: normalizeSourceDate(row.published_at) ?? "",
      updatedAt: normalizeSourceDate(row.updated_at) ?? normalizeSourceDate(row.published_at) ?? "",
    }));
  }

  async scrapeEpisodeContent(novelKey: string, episodeKey: string): Promise<EpisodeContent> {
    return runPython<EpisodeContent>(this.pythonBin, this.site, novelKey, "content", episodeKey);
  }
}

export function createScraper(site: SiteId, options: ScraperOptions = {}): BaseScraper {
  return new PythonScraplingScraper(site, options.pythonBin || "python");
}
