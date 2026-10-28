import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// src/ または dist/ から見て ../../ がリポジトリルート
export const repoRoot = path.resolve(here, "../..");

export interface Config {
  port: number;
  dataDir: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: Number(env.PORT || 3000),
    dataDir: env.DATA_DIR ? path.resolve(env.DATA_DIR) : path.join(repoRoot, "data"),
  };
}
