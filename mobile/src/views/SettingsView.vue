<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { isInsecureRemote } from "../logic/serverUrl";
import { ApiError, changePassword, errorMessage, getBackupSettings, updateBackupSettings, type BackupScheduleSettings } from "../api";
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
const backupBusy = ref(false);
const backupError = ref("");
const backupMsg = ref("");
const backupSettings = ref<BackupScheduleSettings>({ frequency: "hourly", time: "03:00", maxParallel: 5 });
const isAdmin = computed(() => props.settings.role === "admin");

onMounted(async () => {
  if (!isAdmin.value) return;
  try {
    backupSettings.value = await getBackupSettings({ serverUrl: props.settings.serverUrl, token: props.settings.token });
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) emit("unauthorized");
    else backupError.value = errorMessage(e);
  }
});

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

async function saveBackupSchedule() {
  backupError.value = "";
  backupMsg.value = "";
  backupBusy.value = true;
  try {
    backupSettings.value = await updateBackupSettings(
      { serverUrl: props.settings.serverUrl, token: props.settings.token },
      backupSettings.value
    );
    backupMsg.value = "バックアップ定期設定を更新しました";
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) emit("unauthorized");
    else backupError.value = errorMessage(e);
  } finally {
    backupBusy.value = false;
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
      <p v-if="isInsecureRemote(settings.serverUrl)" class="error">⚠ 暗号化されていない接続(http)です。https のサーバーへの切り替えを推奨します。</p>
      <p class="muted">サーバーを変更するには、ログアウトして接続し直してください。</p>
      <button class="danger" @click="emit('logout')">ログアウトしてサーバーを変更</button>
    </div>

    <template v-if="isAdmin">
      <h2>バックアップ定期設定</h2>
      <div class="card">
        <label for="freq" style="margin-top: 0">実行間隔</label>
        <select id="freq" v-model="backupSettings.frequency">
          <option value="hourly">毎時間</option>
          <option value="daily">毎日</option>
          <option value="weekly">毎週</option>
        </select>

        <label for="time">実行時刻(HH:mm)</label>
        <input id="time" v-model="backupSettings.time" type="time" />

        <label for="parallel">同時実行数(1〜10)</label>
        <input id="parallel" v-model.number="backupSettings.maxParallel" type="number" min="1" max="10" />

        <p v-if="backupError" class="error">{{ backupError }}</p>
        <p v-if="backupMsg" class="ok">{{ backupMsg }}</p>
        <div class="row" style="margin-top: 12px">
          <button :disabled="backupBusy" @click="saveBackupSchedule">バックアップ設定を保存</button>
        </div>
      </div>
    </template>

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
