import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// src/ または dist/ から見て ../../ がリポジトリルート
export const repoRoot = path.resolve(here, "../..");

export interface Config {
  port: number;
  dataDir: string;
  cookieSecure: boolean;
  /** CSRF の Origin 検証で追加許可するオリジン(カンマ区切り env ALLOWED_ORIGINS) */
  allowedOrigins: string[];
  userAgent: string;
  clientDist: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: Number(env.PORT || 3000),
    dataDir: env.DATA_DIR ? path.resolve(env.DATA_DIR) : path.join(repoRoot, "data"),
    cookieSecure: env.COOKIE_SECURE === "true",
    allowedOrigins: (env.ALLOWED_ORIGINS || "")
      .split(",")
      .map((s) => s.trim().replace(/\/+$/, ""))
      .filter(Boolean),
    userAgent:
      env.USER_AGENT ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 novel-backup/0.1 (personal use)",
    clientDist: path.join(repoRoot, "client/dist"),
  };
}
