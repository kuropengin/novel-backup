import { createApp } from "vue";
import { createPinia } from "pinia";
import "./styles.css";
import App from "./App.vue";
import router from "./router";
import { setUnauthorizedHandler } from "./api/client";
import { useAuthStore } from "./stores/auth";

const app = createApp(App);
app.use(createPinia());
app.use(router);

// 401 を受けたら auth ストアをクリアして /login へ
const auth = useAuthStore();
setUnauthorizedHandler(() => {
  auth.clear();
  const current = router.currentRoute.value;
  if (current.name !== "login" && current.name !== "setup") {
    void router.push({ name: "login", query: { redirect: current.fullPath } });
  }
});

app.mount("#app");
