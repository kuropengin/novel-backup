import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "local.novelbackup.app",
  appName: "小説ビューア",
  webDir: "dist",
  plugins: {
    // ネイティブ HTTP を使い、LAN の自サーバーへ CORS なしでアクセスする
    CapacitorHttp: { enabled: true },
  },
};

export default config;
