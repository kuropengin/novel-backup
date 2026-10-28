<script setup lang="ts">
import { onMounted, ref } from "vue";
import Icon from "../components/Icon.vue";
import { ApiError, authStatus, errorMessage, login, setupAdmin, type TokenResult } from "../api";
import { normalizeServerUrl, type Settings } from "../storage";

/** ログイン前の画面: サーバー URL の確認 → 初期設定(最初の管理者作成)またはログイン。 */
const props = defineProps<{ settings: Settings }>();
const emit = defineEmits<{ (e: "changed", s: Settings): void }>();

const serverUrl = ref(props.settings.serverUrl);
/** unknown: 未確認 / setup: 初期設定が必要 / login: ログイン可能 */
const serverState = ref<"unknown" | "setup" | "login">("unknown");
const username = ref(props.settings.username);
const password = ref("");
const confirmPw = ref("");
const busy = ref(false);
const error = ref("");

async function checkServer() {
  error.value = "";
  const url = normalizeServerUrl(serverUrl.value);
  if (!url) {
    error.value = "サーバー URL を入力してください";
    return;
  }
  serverUrl.value = url;
  busy.value = true;
  try {
    const st = await authStatus(url);
    serverState.value = st.setupRequired ? "setup" : "login";
    password.value = "";
    confirmPw.value = "";
  } catch (e) {
    serverState.value = "unknown";
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}
onMounted(() => {
  if (serverUrl.value) void checkServer();
});

function finish(url: string, r: TokenResult) {
  password.value = "";
  confirmPw.value = "";
  emit("changed", { serverUrl: url, token: r.token, username: r.user.username, role: r.user.role });
}

async function doLogin() {
  error.value = "";
  if (!username.value || !password.value) {
    error.value = "ユーザー名とパスワードを入力してください";
    return;
  }
  busy.value = true;
  try {
    finish(serverUrl.value, await login(serverUrl.value, username.value, password.value));
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}

async function doSetup() {
  error.value = "";
  if (!username.value || !password.value) {
    error.value = "ユーザー名とパスワードを入力してください";
    return;
  }
  if (password.value !== confirmPw.value) {
    error.value = "パスワード(確認)が一致しません";
    return;
  }
  busy.value = true;
  try {
    finish(serverUrl.value, await setupAdmin(serverUrl.value, username.value, password.value));
  } catch (e) {
    error.value = errorMessage(e);
    if (e instanceof ApiError && e.code === "already_setup") serverState.value = "login";
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="auth">
    <div class="app-mark"><Icon name="book" :size="30" /></div>
    <h1>小説ビューア</h1>
    <p class="muted">サーバーに接続して、ログインまたは初期設定を行います。</p>

    <div class="card">
      <label for="srv" style="margin-top: 0">サーバー URL</label>
      <input id="srv" v-model="serverUrl" type="url" inputmode="url" autocapitalize="off" placeholder="http://192.168.1.10:3000" @input="serverState = 'unknown'" @keyup.enter="checkServer" />
      <div class="row" style="margin-top: 10px">
        <button :disabled="busy" @click="checkServer">{{ serverState === "unknown" ? "接続して確認" : "再確認" }}</button>
      </div>

      <template v-if="serverState === 'setup'">
        <h2>初期設定</h2>
        <p class="muted">このサーバーにはまだユーザーがいません。最初の管理者アカウントを作成します。</p>
        <label for="su">ユーザー名(英数字・_・- の 3〜32 文字)</label>
        <input id="su" v-model="username" autocapitalize="off" autocomplete="username" />
        <label for="sp">パスワード(8 文字以上)</label>
        <input id="sp" v-model="password" type="password" autocomplete="new-password" />
        <label for="sc">パスワード(確認)</label>
        <input id="sc" v-model="confirmPw" type="password" autocomplete="new-password" @keyup.enter="doSetup" />
        <div class="row" style="margin-top: 12px">
          <button :disabled="busy" @click="doSetup">管理者を作成してログイン</button>
        </div>
      </template>

      <template v-else-if="serverState === 'login'">
        <h2>ログイン</h2>
        <label for="usr">ユーザー名</label>
        <input id="usr" v-model="username" autocapitalize="off" autocomplete="username" />
        <label for="pw">パスワード</label>
        <input id="pw" v-model="password" type="password" autocomplete="current-password" @keyup.enter="doLogin" />
        <div class="row" style="margin-top: 12px">
          <button :disabled="busy" @click="doLogin">ログイン</button>
        </div>
      </template>
      <p v-if="error" class="error">{{ error }}</p>
    </div>
    <p class="muted">エミュレータからは http://10.0.2.2:3000 、実機からはサーバー PC の LAN アドレスを指定してください。</p>
  </div>
</template>
