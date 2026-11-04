// Windows / macOS / Linux 共通で android/gradlew assembleDebug を実行する。JDK 21 と Android SDK が必要。
// JAVA_HOME が未設定、または JDK 22 以上を指す場合は %USERPROFILE%\.jdks から JDK 21 を自動検出して使う。
// ANDROID_HOME が未設定なら %LOCALAPPDATA%\Android\Sdk を使う。// Node 26 の型除去で直接実行する(node mobile/scripts/apk.ts)ため、erasable な構文のみ使う。
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "android");
const win = process.platform === "win32";
const env: NodeJS.ProcessEnv = { ...process.env };

/** JDK ディレクトリのメジャーバージョン(release ファイルの JAVA_VERSION、無ければディレクトリ名から)。不明なら null */
function jdkMajor(home: string): number | null {
  try {
    const rel = fs.readFileSync(path.join(home, "release"), "utf8");
    const m = /JAVA_VERSION="?(\d+)(?:\.(\d+))?/.exec(rel);
    if (m) return Number(m[1] === "1" ? m[2] : m[1]);
  } catch {
    /* release が無い */
  }
  const m = /(?:^|[^\d])(\d{2})(?:[.\-_]|$)/.exec(path.basename(home));
  return m ? Number(m[1]) : null;
}

function findJdk21(): string | null {
  const root = path.join(os.homedir(), ".jdks");
  let names: string[] = [];
  try {
    names = fs.readdirSync(root);
  } catch {
    return null;
  }
  const c = names
    .map((n) => path.join(root, n))
    .filter((p) => fs.existsSync(path.join(p, "bin", win ? "java.exe" : "java")) && jdkMajor(p) === 21)
    .sort()
    .reverse();
  return c[0] ?? null;
}

const curMajor = env.JAVA_HOME ? jdkMajor(env.JAVA_HOME) : null;
if (!env.JAVA_HOME || curMajor === null || curMajor > 21) {
  const jdk = findJdk21();
  if (jdk) {
    if (env.JAVA_HOME) console.log(`JAVA_HOME (${env.JAVA_HOME}) は JDK ${curMajor ?? "?"} のため使いません`);
    env.JAVA_HOME = jdk;
    env.PATH = `${path.join(jdk, "bin")}${path.delimiter}${env.PATH ?? env.Path ?? ""}`;
    if (win) env.Path = env.PATH;
  } else if (!env.JAVA_HOME) {
    console.warn("JDK 21 が見つかりません(JAVA_HOME 未設定、~/.jdks にも無し)。PATH 上の java を使います。");
  }
}
console.log(`JDK: ${env.JAVA_HOME ?? "(PATH の java)"}`);

if (!env.ANDROID_HOME && !env.ANDROID_SDK_ROOT) {
  const sdk = win && env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "Android", "Sdk") : path.join(os.homedir(), "Android", "Sdk");
  if (fs.existsSync(sdk)) env.ANDROID_HOME = sdk;
}
console.log(`Android SDK: ${env.ANDROID_HOME ?? env.ANDROID_SDK_ROOT ?? "(未設定)"}`);

// カレントディレクトリを PATH 探索しない環境(NoDefaultCurrentDirectoryInExePath)向けにフルパスで指定
const cmd = win ? `"${path.join(dir, "gradlew.bat")}"` : "./gradlew";
const r = spawnSync(cmd, ["assembleDebug"], { cwd: dir, stdio: "inherit", shell: win, env });
if (r.error) console.error(r.error.message);
else if (r.status === 0) {
  console.log("APK: mobile/android/app/build/outputs/apk/debug/app-debug.apk");
  // サーバーの公開ダウンロード(/download)用に <DATA_DIR>/apk/novel-backup.apk へコピー
  const dataDir = env.DATA_DIR ? path.resolve(env.DATA_DIR) : path.join(dir, "..", "..", "data");
  const dest = path.join(dataDir, "apk", "novel-backup.apk");
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(dir, "app", "build", "outputs", "apk", "debug", "app-debug.apk"), dest);
  console.log(`配布用: ${dest} (サーバーの /download から取得可能)`);
}
process.exit(r.status ?? 1);
