import { createRouter, createWebHistory } from "vue-router";

const routes = [
  { path: "/", component: () => import("./views/Home.vue") },
  { path: "/:pathMatch(.*)*", redirect: "/" },
];

export default createRouter({ history: createWebHistory(), routes });
