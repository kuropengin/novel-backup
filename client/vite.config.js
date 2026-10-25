import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { VitePWA } from "vite-plugin-pwa";

//  PWAひな型: manifest + service worker(generateSW)。devサーバーは /api と /proxy をサーバー(3000)へ
export default defineConfig({
  plugins: [
    vue(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg"],
      manifest: {
        name: "小説バックアップ",
        short_name: "小説BKP",
        theme_color: "#2b6b47",
        background_color: "#ffffff",
        display: "standalone",
        lang: "ja",
        icons: [
          { src: "pwa-192x192.png", sizes: "192x192", type: "image/png" },
          { src: "pwa-512x512.png", sizes: "512x512", type: "image/png" },
        ],
      },
      devOptions: { enabled: true },
    }),
  ],
  server: {
    proxy: {
      "/api": "http://localhost:3000",
      "/proxy": "http://localhost:3000",
    },
  },
});
