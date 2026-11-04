import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PythonUpdater,
  compareVersions,
  isValidTime,
  readFloorRequirements,
  resolveScraperPython,
  setPythonOverlayRoot,
  venvPythonPath,
  type BaselineInfo,
  type UpdaterDeps,
} from "../src/backup/pythonUpdater.js";
import { loadConfig } from "../src/config.js";

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pyupd-"));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  setPythonOverlayRoot(null);
  vi.restoreAllMocks();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const venvsDir = () => path.join(dataDir, "python", "venvs");
const listVenvs = () => (fs.existsSync(venvsDir()) ? fs.readdirSync(venvsDir()).sort() : []);

/** 実 pip/ネットワークを使わない偽 deps。venv は空ディレクトリ + 偽 python ファイル */
function fakeDeps(over: Partial<UpdaterDeps> = {}, baseline: BaselineInfo = { version: "0.5", pythonMinor: "3.12" }) {
  let tick = 0;
  const calls = { pip: [] as string[][], venv: 0 };
  const deps: UpdaterDeps = {
    fetchLatestVersion: async () => "0.6",
    probeBaseline: async () => baseline,
    createVenv: async (dir) => {
      calls.venv++;
      const py = venvPythonPath(dir);
      fs.mkdirSync(path.dirname(py), { recursive: true });
      fs.writeFileSync(py, "");
    },
    pipInstall: async (_py, specs) => {
      calls.pip.push(specs);
    },
    selfTest: async (py) => ({ scrapling: path.basename(path.dirname(path.dirname(py))).split("-")[0]!.slice(1), python: baseline.pythonMinor }),
    // 試行ディレクトリ名が衝突しないよう 1 秒ずつ進める
    now: () => new Date(Date.UTC(2026, 0, 1, 4, 0, tick++)),
    ...over,
  };
  return { deps, calls };
}

const mk = (deps: UpdaterDeps, floors: string[] = ["curl-cffi>=0.17.0"]) => new PythonUpdater(dataDir, "python", deps, floors);

describe("compareVersions / isValidTime", () => {
  it("数値比較(0.10 > 0.9、桁数違いは 0 埋め)", () => {
    expect(compareVersions("0.10", "0.9")).toBeGreaterThan(0);
    expect(compareVersions("0.5", "0.5.0")).toBe(0);
    expect(compareVersions("0.4.15", "0.5")).toBeLessThan(0);
  });
  it("HH:mm 検証", () => {
    expect(isValidTime("04:00")).toBe(true);
    expect(isValidTime("23:59")).toBe(true);
    expect(isValidTime("24:00")).toBe(false);
    expect(isValidTime("4:00")).toBe(false);
  });
});

describe("loadConfig", () => {
  it("既定は有効 / 04:00、false で無効、不正時刻は既定へ", () => {
    expect(loadConfig({})).toMatchObject({ scraplingAutoUpdate: true, scraplingUpdateTime: "04:00" });
    expect(loadConfig({ SCRAPLING_AUTO_UPDATE: "false", SCRAPLING_UPDATE_TIME: "05:30" })).toMatchObject({
      scraplingAutoUpdate: false,
      scraplingUpdateTime: "05:30",
    });
    expect(loadConfig({ SCRAPLING_UPDATE_TIME: "99:99" }).scraplingUpdateTime).toBe("04:00");
  });
});

describe("readFloorRequirements", () => {
  it("scrapling 行とコメントを除く", () => {
    const f = path.join(dataDir, "req.txt");
    fs.writeFileSync(f, "scrapling==0.5\ncurl-cffi>=0.17.0  # c\n\npatchright>=1.64.3\n");
    expect(readFloorRequirements(f)).toEqual(["curl-cffi>=0.17.0", "patchright>=1.64.3"]);
  });
});

describe("runUpdate", () => {
  it("最新がイメージと同じなら何もしない(venv も作らない)", async () => {
    const { deps, calls } = fakeDeps({ fetchLatestVersion: async () => "0.5" });
    const r = await mk(deps).runUpdate();
    expect(r).toMatchObject({ status: "current" });
    expect(calls.venv).toBe(0);
    expect(listVenvs()).toEqual([]);
  });

  it("新版: wheel のみ指定でインストールし、active を切り替える", async () => {
    const { deps, calls } = fakeDeps();
    const u = mk(deps);
    const r = await u.runUpdate();
    expect(r).toEqual({ status: "updated", from: "0.5", to: "0.6" });
    expect(calls.pip[0]).toEqual(["scrapling[fetchers]==0.6", "curl-cffi>=0.17.0"]);
    const st = u.readState();
    expect(st.active?.version).toBe("0.6");
    expect(st.previous).toBeUndefined();
    expect(listVenvs()).toEqual([st.active!.dir]);
    // runPython の解決は venv の python を指す
    setPythonOverlayRoot(dataDir);
    expect(resolveScraperPython("python")).toBe(venvPythonPath(path.join(venvsDir(), st.active!.dir)));
  });

  it("overlay 未設定/無効のときは fallback を返す", async () => {
    expect(resolveScraperPython("python")).toBe("python");
    setPythonOverlayRoot(dataDir);
    expect(resolveScraperPython("python")).toBe("python");
  });

  it("2 回連続更新: previous を保持し、3 世代目以降を削除する", async () => {
    let latest = "0.6";
    const { deps } = fakeDeps({ fetchLatestVersion: async () => latest });
    const u = mk(deps);
    await u.runUpdate();
    const first = u.readState().active!;
    latest = "0.7";
    await u.runUpdate();
    let st = u.readState();
    expect(st.active?.version).toBe("0.7");
    expect(st.previous?.dir).toBe(first.dir);
    expect(listVenvs()).toHaveLength(2);
    latest = "0.8";
    await u.runUpdate();
    st = u.readState();
    expect(st.previous?.version).toBe("0.7");
    expect(listVenvs().sort()).toEqual([st.active!.dir, st.previous!.dir].sort());
    expect(listVenvs().some((n) => n === first.dir)).toBe(false);
  });

  it("pip 失敗: 現行を維持し、試行ディレクトリを削除し、失敗を記録する", async () => {
    const { deps } = fakeDeps({
      pipInstall: async () => {
        throw new Error("no matching wheel");
      },
    });
    const u = mk(deps);
    const r = await u.runUpdate();
    expect(r).toMatchObject({ status: "failed", to: "0.6" });
    expect(u.readState().active).toBeUndefined();
    expect(listVenvs()).toEqual([]);
    expect(u.readState().failed?.version).toBe("0.6");
  });

  it("self-test 失敗: 切り替えず、既存の active はそのまま", async () => {
    let latest = "0.6";
    let ok = true;
    const { deps } = fakeDeps({
      fetchLatestVersion: async () => latest,
      selfTest: async (py) => {
        if (!ok) throw new Error("fixture mismatch");
        return { scrapling: path.basename(path.dirname(path.dirname(py))).split("-")[0]!.slice(1), python: "3.12" };
      },
    });
    const u = mk(deps);
    await u.runUpdate();
    const before = u.readState();
    latest = "0.7";
    ok = false;
    const r = await u.runUpdate();
    expect(r.status).toBe("failed");
    const after = u.readState();
    expect(after.active).toEqual(before.active);
    expect(listVenvs()).toEqual([before.active!.dir]);
  });

  it("self-test が報告する版が要求と違えば失敗扱い", async () => {
    const { deps } = fakeDeps({ selfTest: async () => ({ scrapling: "0.5", python: "3.12" }) });
    const r = await mk(deps).runUpdate();
    expect(r.status).toBe("failed");
    expect(listVenvs()).toEqual([]);
  });

  it("同じ版で失敗した直後は再試行しない。新しい版なら試す", async () => {
    let latest = "0.6";
    let fail = true;
    const { deps, calls } = fakeDeps({
      fetchLatestVersion: async () => latest,
      pipInstall: async () => {
        if (fail) throw new Error("boom");
      },
    });
    const u = mk(deps);
    await u.runUpdate();
    expect(calls.venv).toBe(1);
    expect((await u.runUpdate()).status).toBe("skipped");
    expect(calls.venv).toBe(1);
    latest = "0.7";
    fail = false;
    expect((await u.runUpdate()).status).toBe("updated");
  });

  it("ネットワーク(最新版取得)失敗は状態を変えず failed を記録しない", async () => {
    const { deps } = fakeDeps({
      fetchLatestVersion: async () => {
        throw new Error("offline");
      },
    });
    const u = mk(deps);
    expect((await u.runUpdate()).status).toBe("failed");
    expect(u.readState().failed).toBeUndefined();
  });

  it("同時実行は 1 つだけ", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { deps } = fakeDeps({ pipInstall: async () => gate });
    const u = mk(deps);
    const first = u.runUpdate();
    await vi.waitFor(() => expect(listVenvs().length).toBe(1));
    expect(await u.runUpdate()).toEqual({ status: "skipped", reason: "already running" });
    release();
    expect((await first).status).toBe("updated");
  });
});

describe("reconcile(起動時の整合)", () => {
  async function withOverlay(version: string, baseline: BaselineInfo) {
    const { deps } = fakeDeps({ fetchLatestVersion: async () => version }, { version: "0.5", pythonMinor: "3.12" });
    const u = mk(deps);
    await u.runUpdate();
    return { u, base: baseline };
  }

  it("イメージが overlay 以上に再ビルドされたら overlay を破棄して削除", async () => {
    const { u } = await withOverlay("0.6", { version: "0.6", pythonMinor: "3.12" });
    const u2 = mk(fakeDeps({}, { version: "0.6", pythonMinor: "3.12" }).deps);
    await u2.reconcile();
    expect(u.readState().active).toBeUndefined();
    expect(listVenvs()).toEqual([]);
  });

  it("Python マイナーが変わったら overlay を破棄", async () => {
    await withOverlay("0.6", { version: "0.5", pythonMinor: "3.13" });
    const u2 = mk(fakeDeps({}, { version: "0.5", pythonMinor: "3.13" }).deps);
    await u2.reconcile();
    expect(u2.readState().active).toBeUndefined();
    expect(listVenvs()).toEqual([]);
  });

  it("active の self-test 失敗時は previous へ戻る", async () => {
    let latest = "0.6";
    const f = fakeDeps({ fetchLatestVersion: async () => latest });
    const u = mk(f.deps);
    await u.runUpdate();
    latest = "0.7";
    await u.runUpdate();
    const st = u.readState();
    const broken = fakeDeps({
      selfTest: async (py) => {
        if (py.includes(st.active!.dir)) throw new Error("broken");
        return { scrapling: "0.6", python: "3.12" };
      },
    });
    const u2 = mk(broken.deps);
    await u2.reconcile();
    expect(u2.readState().active?.version).toBe("0.6");
    expect(u2.readState().previous).toBeUndefined();
    expect(listVenvs()).toEqual([st.previous!.dir]);
  });

  it("両方壊れていれば active を外してイメージに戻る", async () => {
    await withOverlay("0.6", { version: "0.5", pythonMinor: "3.12" });
    const u2 = mk(
      fakeDeps({
        selfTest: async () => {
          throw new Error("broken");
        },
      }).deps
    );
    await u2.reconcile();
    expect(u2.readState().active).toBeUndefined();
    setPythonOverlayRoot(dataDir);
    expect(resolveScraperPython("python")).toBe("python");
  });

  it("失敗試行の残骸を掃除し、probe が失敗しても例外を投げない", async () => {
    await withOverlay("0.6", { version: "0.5", pythonMinor: "3.12" });
    fs.mkdirSync(path.join(venvsDir(), "v9.9-orphan"), { recursive: true });
    const u2 = mk(
      fakeDeps({
        probeBaseline: async () => {
          throw new Error("python missing");
        },
      }).deps
    );
    await expect(u2.reconcile()).resolves.toBeUndefined();
    // probe 失敗時は何も変えない
    expect(listVenvs()).toHaveLength(2);
    const u3 = mk(fakeDeps().deps);
    await u3.reconcile();
    expect(listVenvs()).toHaveLength(1);
  });
});
