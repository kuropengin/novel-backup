import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// src/ または dist/ から見て ../../ がリポジトリルート
export const repoRoot = path.resolve(here, "../..");

export interface Config {
  /** 待ち受けアドレス。リバースプロキシ(同一マシン)前提で既定は 127.0.0.1 */
  host: string;
  port: number;
  /** 初回管理者作成(/api/auth/setup)に必要なトークン。未設定なら初期設定は無効 */
  setupToken?: string;
  dataDir: string;
  backupFrequency: "hourly" | "daily" | "weekly";
  backupTime: string;
  backupMaxParallel: number;
  backupPythonBin: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const requestedFrequency = env.BACKUP_FREQUENCY;
  const backupFrequency =
    requestedFrequency === "daily" || requestedFrequency === "weekly" || requestedFrequency === "hourly"
      ? requestedFrequency
      : "hourly";

  return {
    host: env.HOST?.trim() || "127.0.0.1",
    port: Number(env.PORT || 3000),
    setupToken: env.SETUP_TOKEN?.trim() || undefined,
    dataDir: env.DATA_DIR ? path.resolve(env.DATA_DIR) : path.join(repoRoot, "data"),
    backupFrequency,
    backupTime: env.BACKUP_TIME || "03:00",
    backupMaxParallel: Number(env.BACKUP_MAX_PARALLEL || 5),
    backupPythonBin: env.BACKUP_PYTHON_BIN || "python",
  };
}
