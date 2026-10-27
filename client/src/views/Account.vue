<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { authApi } from "../api";
import { errorMessage } from "../api/client";
import { useAuthStore } from "../stores/auth";

const auth = useAuthStore();
const router = useRouter();
const current = ref("");
const next = ref("");
const confirm = ref("");
const error = ref("");
const done = ref("");
const busy = ref(false);

async function submit() {
  error.value = "";
  done.value = "";
  if (next.value !== confirm.value) {
    error.value = "新しいパスワードが一致しません";
    return;
  }
  busy.value = true;
  try {
    await authApi.changePassword(current.value, next.value);
    done.value = "パスワードを変更しました";
    current.value = next.value = confirm.value = "";
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}

async function logout() {
  await auth.logout();
  await router.push({ name: "login" });
}
</script>

<template>
  <h2>アカウント</h2>
  <div class="card">
    <p>
      {{ auth.user?.username }}
      <span class="badge" :class="{ admin: auth.isAdmin }">{{ auth.isAdmin ? "管理者" : "閲覧者" }}</span>
    </p>
    <button class="secondary" @click="logout">ログアウト</button>
  </div>
  <div class="card">
    <h3 style="margin-top: 0">パスワード変更</h3>
    <form class="form" @submit.prevent="submit">
      <label>現在のパスワード<input v-model="current" type="password" autocomplete="current-password" required /></label>
      <label>新しいパスワード(8文字以上)<input v-model="next" type="password" autocomplete="new-password" required /></label>
      <label>新しいパスワード(確認)<input v-model="confirm" type="password" autocomplete="new-password" required /></label>
      <button :disabled="busy">変更する</button>
      <p v-if="error" class="error">{{ error }}</p>
      <p v-if="done" class="ok">{{ done }}</p>
    </form>
  </div>
</template>
