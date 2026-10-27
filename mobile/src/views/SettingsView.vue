<script setup lang="ts">
import { computed, ref } from "vue";
import { errorMessage, login, logout } from "../api";
import { normalizeServerUrl, type Settings } from "../storage";
import { FONT_SIZES_PX, FONT_STACKS, LINE_HEIGHTS, PALETTES, THEMES, THEME_LABELS, type DisplaySettings } from "../theme";

const props = defineProps<{ settings: Settings; display: DisplaySettings }>();
const emit = defineEmits<{ (e: "changed", s: Settings): void; (e: "display", d: DisplaySettings): void; (e: "close"): void }>();

function setDisplay(patch: Partial<DisplaySettings>) {
  emit("display", { ...props.display, ...patch });
}
function onSize(e: Event) {
  setDisplay({ fontSize: Number((e.target as HTMLInputElement).value) as DisplaySettings["fontSize"] });
}
function onAds(e: Event) {
  setDisplay({ hideAds: (e.target as HTMLInputElement).checked });
}
const previewStyle = computed(() => {
  const p = PALETTES[props.display.theme];
  return {
    background: p.bg,
    color: p.fg,
    borderColor: p.border,
    fontSize: FONT_SIZES_PX[props.display.fontSize - 1] + "px",
    lineHeight: String(props.display.lineHeight),
    fontFamily: FONT_STACKS[props.display.font],
  };
});
const previewLinkStyle = computed(() => ({ color: PALETTES[props.display.theme].link }));

const serverUrl = ref(props.settings.serverUrl);
const username = ref(props.settings.username);
const password = ref("");
const busy = ref(false);
const error = ref("");

async function doLogin() {
  error.value = "";
  const url = normalizeServerUrl(serverUrl.value);
  if (!url || !username.value || !password.value) {
    error.value = "サーバー URL・ユーザー名・パスワードを入力してください";
    return;
  }
  busy.value = true;
  try {
    const r = await login(url, username.value, password.value);
    password.value = "";
    emit("changed", { serverUrl: url, token: r.token, username: r.user.username });
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}

async function doLogout() {
  busy.value = true;
  try {
    await logout({ serverUrl: props.settings.serverUrl, token: props.settings.token });
  } catch {
    /* サーバー不達でも端末側のトークンは破棄する */
  } finally {
    busy.value = false;
  }
  emit("changed", { ...props.settings, token: "" });
}
</script>

<template>
  <h1>設定 / ログイン</h1>
  <div class="card">
    <p v-if="settings.token" class="muted">ログイン中: {{ settings.username }}({{ settings.serverUrl }})</p>
    <label for="srv">サーバー URL</label>
    <input id="srv" v-model="serverUrl" type="url" inputmode="url" autocapitalize="off" placeholder="http://192.168.1.10:3000" />
    <label for="usr">ユーザー名</label>
    <input id="usr" v-model="username" autocapitalize="off" autocomplete="username" />
    <label for="pw">パスワード</label>
    <input id="pw" v-model="password" type="password" autocomplete="current-password" @keyup.enter="doLogin" />
    <p v-if="error" class="error">{{ error }}</p>
    <div class="row" style="margin-top: 12px">
      <button :disabled="busy" @click="doLogin">{{ settings.token ? "再ログイン" : "ログイン" }}</button>
      <button v-if="settings.token" class="danger" :disabled="busy" @click="doLogout">ログアウト</button>
      <button v-if="settings.token" class="secondary" @click="emit('close')">戻る</button>
    </div>
  </div>
  <h2>表示</h2>
  <div class="card">
    <label>テーマ</label>
    <div class="row">
      <button v-for="t in THEMES" :key="t" class="small" :class="{ secondary: display.theme !== t }" @click="setDisplay({ theme: t })">
        {{ THEME_LABELS[t] }}
      </button>
    </div>
    <label for="fs">文字サイズ({{ FONT_SIZES_PX[display.fontSize - 1] }}px)</label>
    <input id="fs" type="range" min="1" max="5" step="1" :value="display.fontSize" @input="onSize" />
    <label>行間</label>
    <div class="row">
      <button v-for="l in LINE_HEIGHTS" :key="l" class="small" :class="{ secondary: display.lineHeight !== l }" @click="setDisplay({ lineHeight: l })">{{ l }}</button>
    </div>
    <label>フォント</label>
    <div class="row">
      <button class="small" :class="{ secondary: display.font !== 'mincho' }" @click="setDisplay({ font: 'mincho' })">明朝</button>
      <button class="small" :class="{ secondary: display.font !== 'gothic' }" @click="setDisplay({ font: 'gothic' })">ゴシック</button>
    </div>
    <label class="row" style="align-items: center; gap: 8px">
      <input type="checkbox" style="width: auto" :checked="display.hideAds" @change="onAds" />
      広告を非表示にする
    </label>
    <label>プレビュー</label>
    <div class="preview" :style="previewStyle">
      吾輩は猫である。名前はまだ無い。<ruby>何処<rt>どこ</rt></ruby>で生れたかとんと<a :style="previewLinkStyle">見当</a>がつかぬ。
    </div>
    <p class="muted">変更は次にページを開いたときから反映されます。</p>
  </div>

  <p class="muted">サーバーはこの端末から到達できる LAN アドレスで起動してください。</p>
</template>

<style scoped>
.preview { border: 1px solid; border-radius: 8px; padding: 10px 12px; }
</style>
