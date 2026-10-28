import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "local.novelbackup.app",
  appName: "小説ビューア",
  webDir: "dist",
  // 起動直後・オーバースクロール時の白フラッシュを避ける(既定テーマ=ダークの背景色)
  backgroundColor: "#16181c",
  plugins: {
    // ネイティブ HTTP を使い、LAN の自サーバーへ CORS なしでアクセスする
    CapacitorHttp: { enabled: true },
  },
};

export default config;
