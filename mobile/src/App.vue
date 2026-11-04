<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { App as CapApp } from "@capacitor/app";
import Shell from "./Shell.vue";
import AuthView from "./views/AuthView.vue";
import { ApiError, authStatus, logout, NetworkError } from "./api";
import { EMPTY_SETTINGS, loadSettings, saveSettings, type Settings } from "./storage";
import { loadDisplay, saveDisplay } from "./display/storage";
import { DEFAULT_DISPLAY, type DisplaySettings } from "./display";
import { measureLayout } from "./stores/layout";
import { loadTheme } from "./stores/theme";
import { loadNotifications } from "./stores/notifications";
import { startNetwork } from "./stores/network";
import { clearAdblock, startAdblock } from "./stores/adblock";

const settings = ref<Settings>({ ...EMPTY_SETTINGS });
const display = ref<DisplaySettings>({ ...DEFAULT_DISPLAY });
const ready = ref(false);
const loggedIn = computed(() => !!settings.value.token);

// 広告ブロック: ログイン/ユーザー切替で適用し直し、ログアウト(トークン破棄)で破棄する
watch(
  () => [settings.value.token, settings.value.username, settings.value.serverUrl] as const,
  ([token, username, serverUrl]) => {
    if (token && username && serverUrl) void startAdblock({ serverUrl, token }, username);
    else void clearAdblock();
  },
);

onMounted(async () => {
  measureLayout();
  window.addEventListener("resize", measureLayout);
  await Promise.all([loadTheme(), loadNotifications(), startNetwork()]);
  settings.value = await loadSettings();
  display.value = await loadDisplay();
  ready.value = true;
  void refreshIdentity();
  // ログイン前の画面ではそのままアプリを閉じる(ログイン後は Shell が戻る操作を処理する)
  await CapApp.addListener("backButton", () => {
    if (!loggedIn.value) void CapApp.exitApp();
  });
});
onUnmounted(() => window.removeEventListener("resize", measureLayout));

/** 起動時にトークンの有効性とロール(管理者か)をサーバーに確認する。到達できなければ保存値のまま。 */
async function refreshIdentity() {
  const s = settings.value;
  if (!s.token || !s.serverUrl) return;
  try {
    const st = await authStatus(s.serverUrl, s.token);
    if (!st.user) await onSettingsChanged({ ...s, token: "", role: "" });
    else if (st.user.role !== s.role || st.user.username !== s.username) {
      await onSettingsChanged({ ...s, username: st.user.username, role: st.user.role });
    }
  } catch (e) {
    if (!(e instanceof NetworkError) && !(e instanceof ApiError)) throw e;
  }
}

async function onSettingsChanged(next: Settings) {
  settings.value = next;
  await saveSettings(next);
}
async function onDisplayChanged(next: DisplaySettings) {
  display.value = next;
  await saveDisplay(next);
}
/** 401 を受けたらトークンを破棄してログイン画面へ */
async function onUnauthorized() {
  await onSettingsChanged({ ...settings.value, token: "", role: "" });
}
async function onLogout() {
  try {
    await logout({ serverUrl: settings.value.serverUrl, token: settings.value.token });
  } catch {
    /* サーバー不達でも端末側のトークンは破棄する */
  }
  await onUnauthorized();
}
</script>

<template>
  <template v-if="ready">
    <Shell v-if="loggedIn" :settings="settings" :display="display" @unauthorized="onUnauthorized" @logout="onLogout" @display="onDisplayChanged" />
    <AuthView v-else :settings="settings" @changed="onSettingsChanged" />
  </template>
</template>
