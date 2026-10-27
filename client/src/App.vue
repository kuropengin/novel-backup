<script setup lang="ts">
import { computed } from "vue";
import { RouterLink, RouterView, useRoute, useRouter } from "vue-router";
import { useAuthStore } from "./stores/auth";

const auth = useAuthStore();
const route = useRoute();
const router = useRouter();

const bare = computed(() => !!route.meta.bare || !auth.user);
const reader = computed(() => !!route.meta.reader);

async function logout() {
  await auth.logout();
  await router.push({ name: "login" });
}
</script>

<template>
  <div v-if="bare" class="bare">
    <RouterView />
  </div>
  <div v-else class="shell">
    <aside v-if="!reader" class="sidebar">
      <h1 class="brand">小説バックアップ</h1>
      <nav>
        <RouterLink to="/" exact-active-class="router-link-active">ホーム</RouterLink>
        <RouterLink to="/live">ライブ閲覧</RouterLink>
        <RouterLink to="/bookmarks">ブックマーク</RouterLink>
        <RouterLink to="/backups">バックアップ</RouterLink>
        <template v-if="auth.isAdmin">
          <div class="group">管理</div>
          <RouterLink to="/admin/settings">バックアップ設定</RouterLink>
          <RouterLink to="/admin/runs">実行履歴</RouterLink>
          <RouterLink to="/admin/users">ユーザー管理</RouterLink>
        </template>
        <div class="group">アカウント</div>
        <RouterLink to="/account">アカウント</RouterLink>
      </nav>
      <div class="user">
        {{ auth.user?.username }}({{ auth.isAdmin ? "管理者" : "閲覧者" }})
        <button class="secondary small" style="margin-left: 6px; color: #fff; border-color: #fff" @click="logout">ログアウト</button>
      </div>
    </aside>
    <main class="content" :class="{ reader }">
      <RouterView />
    </main>
    <nav v-if="!reader" class="tabbar">
      <RouterLink to="/" exact-active-class="router-link-active">ホーム</RouterLink>
      <RouterLink to="/live">ライブ</RouterLink>
      <RouterLink to="/bookmarks">ブクマ</RouterLink>
      <RouterLink to="/backups">保存</RouterLink>
      <RouterLink v-if="auth.isAdmin" to="/admin/users">管理</RouterLink>
      <RouterLink to="/account">設定</RouterLink>
    </nav>
  </div>
</template>
