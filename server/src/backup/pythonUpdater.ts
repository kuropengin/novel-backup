/**
 * scrapling の日次自動更新。
 *
 * 方式: DATA_DIR/python/venvs/ 配下に「バージョン毎の venv」を作り、state.json の active ポインタで切り替える。
 * (--target + PYTHONPATH にしない理由: scrapling は lxml / orjson / curl_cffi などコンパイル済み依存を持つ。
 *  --target は PYTHONPATH の優先順位でイメージ側の site-packages と混ざり、バージョンの組み合わせが
 *  不整合になりうる。venv なら依存一式が 1 か所で解決され、Python のマイナーバージョンが変わった場合も
 *  pyvenv/self-test で確実に検知できる。runPython は venv の python を直接 spawn するだけでよい)
 *
 * 安全策: 最新版確認(同じ/古いなら何もしない) → 新ディレクトリへ wheel のみインストール → self-test →
 *  state.json をアトミックに置換(直前の版は previous として保持) → 2 世代より古いものを削除。
 *  どこで失敗しても現行を維持し、失敗した試行ディレクトリは削除する。
 * このモジュールの失敗はバックアップやサーバーに波及させない(例外は呼び出し側へ投げない)。
 */

import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import cron, { type ScheduledTask } from "node-cron";

const LOG = "[PythonUpdater]";
const here = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.resolve(here, "../../python/scrape_with_scrapling.py");
const requirementsPath = path.resolve(here, "../../python/requirements.txt");

const PIP_TIMEOUT_MS = 10 * 60_000;
const VENV_TIMEOUT_MS = 2 * 60_000;
const SELF_TEST_TIMEOUT_MS = 60_000;
const PROBE_TIMEOUT_MS = 30_000;
const FETCH_TIMEOUT_MS = 30_000;
/** 同じバージョンで失敗した場合に再試行を控える期間 */
const FAILED_RETRY_MS = 7 * 24 * 3600_000;

export interface OverlayInfo {
  /** venvs/ 配下のディレクトリ名 */
  dir: string;
  version: string;
  /** venv 作成時の Python マイナーバージョン(例 "3.12") */
  pythonMinor: string;
}

export interface UpdaterState {
  active?: OverlayInfo;
  previous?: OverlayInfo;
  failed?: { version: string; at: string };
}

export interface BaselineInfo {
  /** イメージ(ビルド時 pip)の scrapling バージョン。未インストールなら null */
  version: string | null;
  pythonMinor: string;
}

export type UpdateResult =
  | { status: "updated"; from: string; to: string }
  | { status: "current"; from: string; latest: string }
  | { status: "skipped"; reason: string }
  | { status: "failed"; from: string; to?: string; error: string };

/** 外部要因(ネットワーク・pip・python)を差し替え可能にする(テスト用) */
export interface UpdaterDeps {
  fetchLatestVersion(): Promise<string>;
  probeBaseline(): Promise<BaselineInfo>;
  createVenv(dir: string): Promise<void>;
  pipInstall(venvPython: string, specs: string[]): Promise<void>;
  selfTest(python: string): Promise<{ scrapling: string; python: string }>;
  now(): Date;
}

// ---------------------------------------------------------------- 共通ヘルパ

export function venvPythonPath(venvDir: string): string {
  return process.platform === "win32" ? path.join(venvDir, "Scripts", "python.exe") : path.join(venvDir, "bin", "python");
}

/** "1.2.10" 形式の比較(数値部分のみ。サフィックスは無視)。a>b なら正 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => v.split(".").map((p) => Number.parseInt(p, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

const isStableVersion = (v: string) => /^\d+(\.\d+)*$/.test(v);

interface ProcResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runProc(cmd: string, args: string[], timeoutMs: number, track?: (c: ChildProcess | null) => void): Promise<ProcResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env: { ...process.env, PYTHONUTF8: "1", PIP_DISABLE_PIP_VERSION_CHECK: "1", PIP_NO_INPUT: "1" },
      windowsHide: true,
    });
    track?.(child);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`timeout after ${timeoutMs / 1000}s: ${path.basename(cmd)} ${args.slice(0, 3).join(" ")}`));
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      track?.(null);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      track?.(null);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

const tail = (s: string, n = 400) => s.trim().slice(-n);

/** requirements.txt から scrapling 以外の行(curl-cffi 等の下限指定)を取り出す。新 venv にも同じ下限を課す */
export function readFloorRequirements(file = requirementsPath): string[] {
  try {
    return fs
      .readFileSync(file, "utf8")
      .split(/\r?\n/)
      .map((l) => l.replace(/#.*/, "").trim())
      .filter((l) => l && !/^scrapling\b/i.test(l));
  } catch {
    return [];
  }
}

export function createRealDeps(pythonBin: string, track?: (c: ChildProcess | null) => void): UpdaterDeps {
  return {
    async fetchLatestVersion() {
      const res = await fetch("https://pypi.org/pypi/scrapling/json", { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`PyPI HTTP ${res.status}`);
      const body = (await res.json()) as { info?: { version?: string } };
      const v = body.info?.version;
      if (!v || !isStableVersion(v)) throw new Error(`unexpected latest version: ${String(v)}`);
      return v;
    },
    async probeBaseline() {
      const code =
        "import json,sys\n" +
        "try:\n import importlib.metadata as m; v=m.version('scrapling')\n" +
        "except Exception: v=None\n" +
        "print(json.dumps({'version':v,'pythonMinor':'%d.%d'%sys.version_info[:2]}))";
      const r = await runProc(pythonBin, ["-I", "-c", code], PROBE_TIMEOUT_MS, track);
      if (r.code !== 0) throw new Error(`baseline probe failed: ${tail(r.stderr)}`);
      return JSON.parse(r.stdout.trim().split(/\r?\n/).pop()!) as BaselineInfo;
    },
    async createVenv(dir) {
      const r = await runProc(pythonBin, ["-m", "venv", dir], VENV_TIMEOUT_MS, track);
      if (r.code !== 0) throw new Error(`venv creation failed: ${tail(r.stderr)}`);
    },
    async pipInstall(venvPython, specs) {
      // wheel のみ(setup.py を実行しない)。キャッシュは使わない
      const args = ["-m", "pip", "install", "--only-binary", ":all:", "--no-cache-dir", "--no-input", ...specs];
      const r = await runProc(venvPython, args, PIP_TIMEOUT_MS, track);
      if (r.code !== 0) throw new Error(`pip install failed: ${tail(r.stderr)}`);
    },
    async selfTest(python) {
      // -I: カレントディレクトリや PYTHONPATH を読まない
      const r = await runProc(python, ["-I", "-X", "utf8", scriptPath, "--self-test"], SELF_TEST_TIMEOUT_MS, track);
      const line = r.stdout.trim().split(/\r?\n/).pop() ?? "";
      let parsed: { ok?: boolean; data?: { scrapling: string; python: string }; error?: string };
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new Error(`self-test produced no JSON: ${tail(r.stdout + r.stderr)}`);
      }
      if (r.code !== 0 || !parsed.ok || !parsed.data) throw new Error(parsed.error || `self-test exit ${r.code}: ${tail(r.stderr)}`);
      return parsed.data;
    },
    now: () => new Date(),
  };
}

// ---------------------------------------------------------------- active 解決(runPython から使う)

let activeRoot: string | null = null;

/** 自動更新が有効なとき DATA_DIR/python を登録する。未登録なら常にイメージの python を使う */
export function setPythonOverlayRoot(dataDir: string | null): void {
  activeRoot = dataDir ? path.join(dataDir, "python") : null;
}

function readStateFile(root: string): UpdaterState {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(root, "state.json"), "utf8")) as UpdaterState;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * spawn 時点の有効な Python 実行ファイルを返す。overlay が無い/壊れている場合は fallback(イメージの python)。
 * spawn 毎に呼ぶので、切り替え後の新規 spawn から新版になり、実行中のプロセスは旧パスのまま走り切る。
 */
export function resolveScraperPython(fallback: string): string {
  if (!activeRoot) return fallback;
  try {
    const active = readStateFile(activeRoot).active;
    if (!active) return fallback;
    const py = venvPythonPath(path.join(activeRoot, "venvs", active.dir));
    return fs.existsSync(py) ? py : fallback;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------- 本体

export class PythonUpdater {
  private running = false;
  private child: ChildProcess | null = null;
  private job: ScheduledTask | null = null;
  private readonly root: string;
  private readonly venvs: string;

  private readonly deps: UpdaterDeps;

  constructor(
    dataDir: string,
    pythonBin: string,
    deps?: UpdaterDeps,
    private readonly floors: string[] = readFloorRequirements()
  ) {
    this.root = path.join(dataDir, "python");
    this.venvs = path.join(this.root, "venvs");
    this.deps = deps ?? createRealDeps(pythonBin, (c) => (this.child = c));
  }

  readState(): UpdaterState {
    return readStateFile(this.root);
  }

  private writeState(state: UpdaterState): void {
    fs.mkdirSync(this.root, { recursive: true });
    const tmp = path.join(this.root, "state.json.tmp");
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, path.join(this.root, "state.json")); // アトミックな置換
  }

  private rmDir(name: string): void {
    try {
      fs.rmSync(path.join(this.venvs, name), { recursive: true, force: true });
    } catch (e) {
      console.warn(`${LOG} could not remove ${name}:`, e);
    }
  }

  /** state が参照していない venv ディレクトリ(失敗試行の残骸・3 世代目以降)を削除する */
  private sweep(state: UpdaterState): void {
    const keep = new Set([state.active?.dir, state.previous?.dir].filter(Boolean) as string[]);
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.venvs);
    } catch {
      return;
    }
    for (const n of names) if (!keep.has(n)) this.rmDir(n);
  }

  /**
   * 起動時の整合チェック(スクレイプ開始前に呼ぶ。例外は投げない)。
   * - イメージの scrapling 以下、または Python マイナーが違う overlay は破棄(イメージ再ビルドへの追従)
   * - active の self-test に失敗したら previous へ戻す。それも駄目ならイメージの python に戻す
   */
  async reconcile(): Promise<void> {
    try {
      let state = this.readState();
      if (!state.active && !state.previous) {
        this.sweep(state);
        return;
      }
      const base = await this.deps.probeBaseline();
      const usable = (o: OverlayInfo | undefined): o is OverlayInfo =>
        !!o &&
        o.pythonMinor === base.pythonMinor &&
        (base.version === null || compareVersions(o.version, base.version) > 0) &&
        fs.existsSync(venvPythonPath(path.join(this.venvs, o.dir)));

      let active = usable(state.active) ? state.active : undefined;
      let previous = usable(state.previous) ? state.previous : undefined;
      if (state.active && !active) console.log(`${LOG} discard overlay ${state.active.version} (image=${base.version} py${base.pythonMinor}, overlay py${state.active.pythonMinor})`);

      if (active && !(await this.healthy(active))) {
        console.error(`${LOG} active overlay ${active.version} failed self-test`);
        active = undefined;
      }
      if (!active && previous && (await this.healthy(previous))) {
        console.log(`${LOG} rollback to previous overlay ${previous.version}`);
        active = previous;
        previous = undefined;
      }
      state = { active, previous: active ? previous : undefined, failed: state.failed };
      this.writeState(state);
      this.sweep(state);
      console.log(`${LOG} active scrapling: ${active ? `overlay ${active.version}` : `image ${base.version ?? "none"}`}`);
    } catch (e) {
      console.error(`${LOG} reconcile failed (image python is used as is):`, e);
    }
  }

  private async healthy(o: OverlayInfo): Promise<boolean> {
    try {
      await this.deps.selfTest(venvPythonPath(path.join(this.venvs, o.dir)));
      return true;
    } catch {
      return false;
    }
  }

  /** 1 回分の更新確認と更新。同時実行は 1 つだけ。例外は投げない */
  async runUpdate(): Promise<UpdateResult> {
    if (this.running) {
      console.log(`${LOG} update already running; skipped`);
      return { status: "skipped", reason: "already running" };
    }
    this.running = true;
    let from = "unknown";
    let to: string | undefined;
    let attempt: string | undefined;
    try {
      const base = await this.deps.probeBaseline();
      const state = this.readState();
      from = state.active?.version ?? base.version ?? "none";
      const latest = await this.deps.fetchLatestVersion();
      to = latest;
      if (compareVersions(latest, from === "none" ? "0" : from) <= 0) {
        console.log(`${LOG} scrapling ${from} is up to date (latest ${latest})`);
        return { status: "current", from, latest };
      }
      if (state.failed?.version === latest && this.deps.now().getTime() - Date.parse(state.failed.at) < FAILED_RETRY_MS) {
        console.log(`${LOG} scrapling ${latest} failed recently; skipped until a newer version or 7 days pass`);
        return { status: "skipped", reason: `${latest} failed recently` };
      }

      console.log(`${LOG} updating scrapling ${from} -> ${latest}`);
      const stamp = this.deps.now().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
      attempt = `v${latest}-${stamp}`;
      const dir = path.join(this.venvs, attempt);
      fs.mkdirSync(this.venvs, { recursive: true });
      await this.deps.createVenv(dir);
      const py = venvPythonPath(dir);
      await this.deps.pipInstall(py, [`scrapling[fetchers]==${latest}`, ...this.floors]);
      const t = await this.deps.selfTest(py);
      if (t.scrapling !== latest) throw new Error(`self-test reports scrapling ${t.scrapling}, expected ${latest}`);
      if (t.python !== base.pythonMinor) throw new Error(`python ${t.python} differs from image ${base.pythonMinor}`);

      // 切り替え: active=new, previous=旧 active。旧 previous 以前は削除(実行中の旧 active は残る)
      const next: UpdaterState = {
        active: { dir: attempt, version: latest, pythonMinor: t.python },
        previous: state.active,
      };
      this.writeState(next);
      attempt = undefined;
      this.sweep(next);
      console.log(`${LOG} updated scrapling ${from} -> ${latest}`);
      return { status: "updated", from, to: latest };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`${LOG} update failed (${from} -> ${to ?? "?"}); keeping current: ${msg}`);
      if (attempt) {
        this.rmDir(attempt);
        // 版が決まってからの失敗(pip/self-test)だけ再試行を抑制する。ネットワーク不通は翌日また試す
        try {
          this.writeState({ ...this.readState(), failed: { version: to!, at: this.deps.now().toISOString() } });
        } catch {
          /* 記録できなくても影響なし */
        }
      }
      return { status: "failed", from, to, error: msg };
    } finally {
      this.running = false;
    }
  }

  /** 毎日 HH:mm(プロセスの TZ)に runUpdate を実行する cron を登録する */
  start(time: string): void {
    if (this.job) return;
    const [hh, mm] = time.split(":").map(Number);
    const expr = `${mm} ${hh} * * *`;
    this.job = cron.schedule(expr, () => {
      void this.runUpdate();
    });
    console.log(`${LOG} daily update scheduled at ${time} (${expr})`);
  }

  stop(): void {
    this.job?.stop();
    this.job = null;
    // 実行中の pip などを残さない。試行ディレクトリの残骸は次回起動時の reconcile が掃除する
    this.child?.kill("SIGKILL");
  }
}

/** HH:mm(00:00〜23:59)の検証 */
export function isValidTime(v: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
}

/**
 * サーバー起動時の初期化。起動を妨げないよう例外は握りつぶす。
 * 無効(enabled=false)のときは overlay も使わない(イメージ同梱の版で動く)。
 */
export async function initPythonUpdater(opts: {
  enabled: boolean;
  dataDir: string;
  pythonBin: string;
  time: string;
}): Promise<PythonUpdater | null> {
  if (!opts.enabled) {
    setPythonOverlayRoot(null);
    console.log(`${LOG} auto update disabled (SCRAPLING_AUTO_UPDATE=false); image scrapling is used`);
    return null;
  }
  try {
    const updater = new PythonUpdater(opts.dataDir, opts.pythonBin);
    await updater.reconcile();
    setPythonOverlayRoot(opts.dataDir);
    updater.start(opts.time);
    return updater;
  } catch (e) {
    console.error(`${LOG} init failed:`, e);
    return null;
  }
}
