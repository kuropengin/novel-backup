<script setup lang="ts">
import { ref } from "vue";
import { ApiError, changePassword, errorMessage } from "../api";
import type { Settings } from "../storage";

/** 設定(ログイン後): アカウントとサーバー、パスワード変更。本文の表示設定は上バーの「Aa」から。 */
const props = defineProps<{ settings: Settings }>();
const emit = defineEmits<{ (e: "logout"): void; (e: "unauthorized"): void }>();

const curPw = ref("");
const newPw = ref("");
const newPw2 = ref("");
const msg = ref("");
const error = ref("");
const busy = ref(false);

async function doChangePassword() {
  msg.value = "";
  error.value = "";
  if (!curPw.value || !newPw.value) {
    error.value = "現在のパスワードと新しいパスワードを入力してください";
    return;
  }
  if (newPw.value !== newPw2.value) {
    error.value = "新しいパスワード(確認)が一致しません";
    return;
  }
  busy.value = true;
  try {
    await changePassword({ serverUrl: props.settings.serverUrl, token: props.settings.token }, curPw.value, newPw.value);
    curPw.value = newPw.value = newPw2.value = "";
    msg.value = "パスワードを変更しました(他の端末はログアウトされます)";
  } catch (e) {
    if (e instanceof ApiError && e.status === 401 && e.code === "unauthorized") emit("unauthorized");
    else error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="page">
    <h2>アカウント</h2>
    <div class="card">
      <div><strong>{{ settings.username }}</strong> <span class="muted">({{ settings.role === "admin" ? "管理者" : "閲覧者" }})</span></div>
      <label>サーバー URL</label>
      <div style="word-break: break-all">{{ settings.serverUrl }}</div>
      <p class="muted">サーバーを変更するには、ログアウトして接続し直してください。</p>
      <button class="danger" @click="emit('logout')">ログアウトしてサーバーを変更</button>
    </div>

    <h2>パスワード変更</h2>
    <div class="card">
      <label for="cp" style="margin-top: 0">現在のパスワード</label>
      <input id="cp" v-model="curPw" type="password" autocomplete="current-password" />
      <label for="np">新しいパスワード(8 文字以上)</label>
      <input id="np" v-model="newPw" type="password" autocomplete="new-password" />
      <label for="np2">新しいパスワード(確認)</label>
      <input id="np2" v-model="newPw2" type="password" autocomplete="new-password" @keyup.enter="doChangePassword" />
      <p v-if="error" class="error">{{ error }}</p>
      <p v-if="msg" class="ok">{{ msg }}</p>
      <div class="row" style="margin-top: 12px">
        <button :disabled="busy" @click="doChangePassword">変更</button>
      </div>
    </div>
  </div>
</template>
