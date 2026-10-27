import { createRouter, createWebHistory, type RouteRecordRaw } from "vue-router";
import { useAuthStore } from "./stores/auth";

declare module "vue-router" {
  interface RouteMeta {
    /** 公開ページ(ログイン不要) */
    public?: boolean;
    /** admin のみ */
    admin?: boolean;
    /** ナビを隠して全画面寄りに表示 */
    reader?: boolean;
    /** ナビなしのシンプルレイアウト */
    bare?: boolean;
    title?: string;
  }
}

const routes: RouteRecordRaw[] = [
  { path: "/setup", name: "setup", component: () => import("./views/Setup.vue"), meta: { public: true, bare: true, title: "初期セットアップ" } },
  { path: "/login", name: "login", component: () => import("./views/Login.vue"), meta: { public: true, bare: true, title: "ログイン" } },
  { path: "/", name: "home", component: () => import("./views/Home.vue"), meta: { title: "ホーム" } },
  { path: "/account", name: "account", component: () => import("./views/Account.vue"), meta: { title: "アカウント" } },
  { path: "/admin/users", name: "admin-users", component: () => import("./views/AdminUsers.vue"), meta: { admin: true, title: "ユーザー管理" } },

  { path: "/live", name: "live", component: () => import("./views/Live.vue"), meta: { title: "ライブ閲覧" } },
  { path: "/live/:site/:novelKey", name: "live-novel", component: () => import("./views/LiveNovel.vue"), meta: { title: "作品(ライブ)" } },
  { path: "/live/:site/:novelKey/:episodeKey", name: "live-episode", component: () => import("./views/LiveEpisode.vue"), meta: { reader: true, title: "本文(ライブ)" } },
  { path: "/bookmarks", name: "bookmarks", component: () => import("./views/Bookmarks.vue"), meta: { title: "ブックマーク" } },
  { path: "/backups", name: "backups", component: () => import("./views/Backups.vue"), meta: { title: "バックアップ" } },
  { path: "/backups/:novelId", name: "backup-novel", component: () => import("./views/BackupNovel.vue"), meta: { title: "バックアップ作品" } },
  { path: "/backups/:novelId/episodes/:episodeId", name: "backup-episode", component: () => import("./views/BackupEpisode.vue"), meta: { reader: true, title: "本文(バックアップ)" } },
  { path: "/admin/settings", name: "admin-settings", component: () => import("./views/AdminSettings.vue"), meta: { admin: true, title: "バックアップ設定" } },
  { path: "/admin/runs", name: "admin-runs", component: () => import("./views/AdminRuns.vue"), meta: { admin: true, title: "実行履歴" } },

  { path: "/:pathMatch(.*)*", redirect: "/" },
];

const router = createRouter({ history: createWebHistory(), routes });

router.beforeEach(async (to) => {
  const auth = useAuthStore();
  await auth.init();

  if (auth.setupRequired) {
    return to.name === "setup" ? true : { name: "setup" };
  }
  if (to.name === "setup") return { name: "home" };

  if (!auth.user) {
    if (to.meta.public) return true;
    return { name: "login", query: { redirect: to.fullPath } };
  }
  if (to.name === "login") return { name: "home" };
  if (to.meta.admin && auth.user.role !== "admin") return { name: "home" };
  return true;
});

router.afterEach((to) => {
  document.title = to.meta.title ? `${to.meta.title} - 小説バックアップ` : "小説バックアップ";
});

export default router;
