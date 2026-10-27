import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { VitePWA } from "vite-plugin-pwa";

// PWA: manifest + service worker(generateSW)。dev サーバーは /api と /proxy をサーバー(3000)へ中継
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
      workbox: {
        navigateFallbackDenylist: [/^\/api\//, /^\/proxy\//],
        // /api/auth, /api/live, /proxy/{site} はキャッシュしない(認証・ライブ取得は常にネットワーク)
        runtimeCaching: [
          {
            // バックアップ閲覧はオフライン時に最後に見た内容を表示する
            urlPattern: ({ url, request }) => request.method === "GET" && url.pathname.startsWith("/api/backups/novels"),
            handler: "NetworkFirst",
            options: {
              cacheName: "backups",
              networkTimeoutSeconds: 5,
              expiration: { maxEntries: 300, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [200] },
            },
          },
          {
            urlPattern: ({ url }) => url.pathname === "/proxy/img",
            handler: "CacheFirst",
            options: {
              cacheName: "proxy-img",
              expiration: { maxEntries: 500, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [200] },
            },
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  server: {
    proxy: {
      // xfwd: 元の Host を X-Forwarded-Host で渡す(サーバーの CSRF Origin 検証が参照する)
      "/api": { target: "http://localhost:3000", xfwd: true },
      "/proxy": { target: "http://localhost:3000", xfwd: true },
    },
  },
});
