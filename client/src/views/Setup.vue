<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { errorMessage } from "../api/client";
import { useAuthStore } from "../stores/auth";

const auth = useAuthStore();
const router = useRouter();
const username = ref("");
const password = ref("");
const confirm = ref("");
const error = ref("");
const busy = ref(false);

async function submit() {
  error.value = "";
  if (password.value !== confirm.value) {
    error.value = "パスワードが一致しません";
    return;
  }
  busy.value = true;
  try {
    await auth.setup(username.value, password.value);
    await router.push({ name: "home" });
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="card">
    <h2>初期セットアップ</h2>
    <p class="muted">最初の管理者アカウントを作成します。</p>
    <form class="form" @submit.prevent="submit">
      <label>ユーザー名<input v-model="username" autocomplete="username" required /></label>
      <label>パスワード(8文字以上)<input v-model="password" type="password" autocomplete="new-password" required /></label>
      <label>パスワード(確認)<input v-model="confirm" type="password" autocomplete="new-password" required /></label>
      <button :disabled="busy">管理者を作成</button>
      <p v-if="error" class="error">{{ error }}</p>
    </form>
  </div>
</template>
