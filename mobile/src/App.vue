<script setup lang="ts">
import { onMounted, ref } from "vue";
import { App as CapApp } from "@capacitor/app";
import Home from "./views/Home.vue";
import SettingsView from "./views/SettingsView.vue";
import { loadSettings, saveSettings, type Settings } from "./storage";
import { loadDisplay, saveDisplay } from "./theme/storage";
import { DEFAULT_DISPLAY, type DisplaySettings } from "./theme";

const settings = ref<Settings>({ serverUrl: "", token: "", username: "" });
const display = ref<DisplaySettings>({ ...DEFAULT_DISPLAY });
const ready = ref(false);
const view = ref<"home" | "settings">("settings");

onMounted(async () => {
  settings.value = await loadSettings();
  display.value = await loadDisplay();
  view.value = settings.value.token ? "home" : "settings";
  ready.value = true;
  // 設定画面から開いた場合はホームへ戻し、ホームなら通常どおりアプリを閉じる
  CapApp.addListener("backButton", () => {
    if (view.value === "settings" && settings.value.token) view.value = "home";
    else void CapApp.exitApp();
  });
});

async function onSettingsChanged(next: Settings) {
  settings.value = next;
  await saveSettings(next);
  view.value = next.token ? "home" : "settings";
}
async function onDisplayChanged(next: DisplaySettings) {
  display.value = next;
  await saveDisplay(next);
}
/** 401 を受けたらトークンを破棄して設定(再ログイン)画面へ */
async function onUnauthorized() {
  await onSettingsChanged({ ...settings.value, token: "" });
}
</script>

<template>
  <template v-if="ready">
    <SettingsView v-if="view === 'settings'" :settings="settings" :display="display" @changed="onSettingsChanged" @display="onDisplayChanged" @close="view = 'home'" />
    <Home v-else :settings="settings" :display="display" @settings="view = 'settings'" @unauthorized="onUnauthorized" />
  </template>
</template>
