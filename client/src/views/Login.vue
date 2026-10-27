<script setup lang="ts">
import { ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { errorMessage } from "../api/client";
import { useAuthStore } from "../stores/auth";

const auth = useAuthStore();
const route = useRoute();
const router = useRouter();
const username = ref("");
const password = ref("");
const error = ref("");
const busy = ref(false);

async function submit() {
  error.value = "";
  busy.value = true;
  try {
    await auth.login(username.value, password.value);
    const redirect = route.query.redirect;
    // オープンリダイレクト対策: アプリ内パスのみ許可
    const to = typeof redirect === "string" && redirect.startsWith("/") && !redirect.startsWith("//") ? redirect : "/";
    await router.push(to);
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="card">
    <h2>ログイン</h2>
    <form class="form" @submit.prevent="submit">
      <label>ユーザー名<input v-model="username" autocomplete="username" required /></label>
      <label>パスワード<input v-model="password" type="password" autocomplete="current-password" required /></label>
      <button :disabled="busy">ログイン</button>
      <p v-if="error" class="error">{{ error }}</p>
    </form>
  </div>
</template>
