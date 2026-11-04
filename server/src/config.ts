import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// src/ または dist/ から見て ../../ がリポジトリルート
export const repoRoot = path.resolve(here, "../..");

export interface Config {
  /** 待ち受けアドレス。リバースプロキシ(同一マシン)前提で既定は 127.0.0.1 */
  host: string;
  port: number;
  /** X-Forwarded-For を信用するプロキシ(Express の trust proxy 値。カンマ区切りの IP/CIDR/プリセット名)。既定 loopback */
  trustProxy: string[];
  /** 初回管理者作成(/api/auth/setup)に必要なトークン。未設定なら初期設定は無効 */
  setupToken?: string;
  dataDir: string;
  backupFrequency: "hourly" | "daily" | "weekly";
  backupTime: string;
  backupMaxParallel: number;
  backupPythonBin: string;
  /** scrapling の日次自動更新(SCRAPLING_AUTO_UPDATE=false で無効) */
  scraplingAutoUpdate: boolean;
  /** 自動更新の実行時刻 HH:mm(プロセスの TZ) */
  scraplingUpdateTime: string;
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const requestedFrequency = env.BACKUP_FREQUENCY;
  const backupFrequency =
    requestedFrequency === "daily" || requestedFrequency === "weekly" || requestedFrequency === "hourly"
      ? requestedFrequency
      : "hourly";

  let scraplingUpdateTime = env.SCRAPLING_UPDATE_TIME?.trim() || "04:00";
  if (!TIME_RE.test(scraplingUpdateTime)) {
    console.warn(`[Config] SCRAPLING_UPDATE_TIME="${scraplingUpdateTime}" は HH:mm ではないため 04:00 を使います`);
    scraplingUpdateTime = "04:00";
  }

  return {
    host: env.HOST?.trim() || "127.0.0.1",
    port: Number(env.PORT || 3000),
    trustProxy: (env.TRUST_PROXY || "loopback")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    setupToken: env.SETUP_TOKEN?.trim() || undefined,
    dataDir: env.DATA_DIR ? path.resolve(env.DATA_DIR) : path.join(repoRoot, "data"),
    backupFrequency,
    backupTime: env.BACKUP_TIME || "03:00",
    backupMaxParallel: Number(env.BACKUP_MAX_PARALLEL || 5),
    backupPythonBin: env.BACKUP_PYTHON_BIN || "python",
    scraplingAutoUpdate: (env.SCRAPLING_AUTO_UPDATE ?? "true").trim().toLowerCase() !== "false",
    scraplingUpdateTime,
  };
}
