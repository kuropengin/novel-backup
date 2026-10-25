<script setup>
import { RouterLink, RouterView } from "vue-router";
</script>

<template>
  <div class="shell">
    <aside class="sidebar">
      <h1 class="brand">小説バックアップ</h1>
      <nav>
        <RouterLink to="/">ホーム</RouterLink>
      </nav>
    </aside>
    <main class="content">
      <RouterView />
    </main>
  </div>
</template>

<style>
* { box-sizing: border-box; }
body { margin: 0; font-family: system-ui, "Hiragino Sans", "Meiryo", sans-serif; background: #f5f6f7; color: #232629; }
.shell { display: flex; min-height: 100vh; }
.sidebar { width: 200px; padding: 16px; background: #2b6b47; color: #fff; }
.sidebar .brand { font-size: 15px; margin: 8px 0 16px; }
.sidebar nav { display: flex; flex-direction: column; gap: 8px; }
.sidebar a { color: #d8e8df; text-decoration: none; padding: 6px 8px; border-radius: 6px; }
.sidebar a.router-link-active { background: #3d8259; color: #fff; }
.content { flex: 1; padding: 24px; }
</style>
