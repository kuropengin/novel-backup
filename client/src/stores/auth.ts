import { defineStore } from "pinia";
import { authApi } from "../api";
import type { User } from "../api/types";

export const useAuthStore = defineStore("auth", {
  state: () => ({
    user: null as User | null,
    setupRequired: false,
    loaded: false,
  }),
  getters: {
    isAdmin: (s) => s.user?.role === "admin",
    isLoggedIn: (s) => s.user !== null,
  },
  actions: {
    /** /api/auth/status を取得(初回のみ。force で再取得)。 */
    async init(force = false) {
      if (this.loaded && !force) return;
      try {
        const st = await authApi.status();
        this.user = st.user;
        this.setupRequired = st.setupRequired;
      } catch {
        this.user = null;
      }
      this.loaded = true;
    },
    async setup(username: string, password: string) {
      const r = await authApi.setup(username, password);
      this.user = r.user;
      this.setupRequired = false;
    },
    async login(username: string, password: string) {
      const r = await authApi.login(username, password);
      this.user = r.user;
    },
    async logout() {
      try {
        await authApi.logout();
      } finally {
        this.clear();
      }
    },
    /** ローカル状態のみクリア(401 受信時など)。 */
    clear() {
      this.user = null;
    },
  },
});
