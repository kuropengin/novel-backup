<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from "vue";
import { ApiError, deleteBookmark, errorMessage, listBookmarks, saveBookmark, type Bookmark } from "../api";
import { openInBrowser, type IabEvent, type IabInstance } from "../browser";
import { pageScriptCode, toastCode, type PagePayload } from "../inject";
import type { Settings } from "../storage";
import { buildCss, buildMinimalCss, type DisplaySettings } from "../theme";

const props = defineProps<{ settings: Settings; display: DisplaySettings }>();
const emit = defineEmits<{ (e: "settings"): void; (e: "unauthorized"): void }>();

const SITES = [
  { name: "ハーメルン", url: "https://syosetu.org/" },
  { name: "小説家になろう", url: "https://yomou.syosetu.com/" },
  { name: "カクヨム", url: "https://kakuyomu.jp/" },
];
const SITE_NAMES: Record<string, string> = { hameln: "ハーメルン", narou: "なろう", kakuyomu: "カクヨム" };

const items = ref<Bookmark[]>([]);
const loading = ref(false);
const error = ref("");
let alive = true;

const cfg = () => ({ serverUrl: props.settings.serverUrl, token: props.settings.token });

async function load() {
  loading.value = true;
  error.value = "";
  try {
    items.value = await listBookmarks(cfg());
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) emit("unauthorized");
    else error.value = errorMessage(e);
  } finally {
    loading.value = false;
  }
}
onMounted(load);
onUnmounted(() => {
  alive = false;
});

async function remove(b: Bookmark) {
  if (!confirm(`「${b.title || b.novelKey}」をお気に入りから削除しますか?`)) return;
  try {
    await deleteBookmark(cfg(), b.id);
    items.value = items.value.filter((x) => x.id !== b.id);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) emit("unauthorized");
    else error.value = errorMessage(e);
  }
}

/** ★ 押下で届いたメッセージを保存し、結果をページ内トーストで返す。 */
async function handleSave(browser: { executeScript(s: { code: string }): void }, p: PagePayload) {
  const toast = (msg: string, kind: "ok" | "error") => browser.executeScript({ code: toastCode(msg, kind) });
  try {
    const r = await saveBookmark(cfg(), { url: p.url, title: p.title || undefined, author: p.author || undefined });
    toast(r.created ? "保存しました" : "登録済みです", "ok");
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      toast("ログインの有効期限が切れました。ブラウザを閉じて再ログインしてください", "error");
      if (alive) emit("unauthorized");
    } else {
      toast(errorMessage(e), "error"); // 作品ページではありません / サーバーに接続できません 等
    }
  }
}

/** 開いているブラウザ(あれば)と、表示中ページのホスト名。表示設定の変更を即時反映するために保持。 */
let current: { browser: IabInstance; host: string } | null = null;

function hostOf(url?: string): string {
  try {
    return url ? new URL(url).hostname : "";
  } catch {
    return "";
  }
}

/** テーマ CSS を注入(3 サイト以外のホストでは空文字なので何もしない)。失敗しても無害。 */
function injectCss(browser: IabInstance, host: string, minimal: boolean) {
  const code = minimal ? buildMinimalCss(host, props.display) : buildCss(host, props.display);
  if (!code) return;
  try {
    browser.insertCSS({ code });
  } catch {
    /* 注入失敗はページ表示に影響させない */
  }
}

// 設定画面は閉じたブラウザの後で開くのが通常だが、開いたままの場合は新しい CSS を重ねて注入する
// (色・文字は後勝ちで反映。広告を「非表示→表示」に戻す変更は次回のページ読み込みから)。
watch(
  () => props.display,
  () => {
    if (current) injectCss(current.browser, current.host, false);
  },
  { deep: true },
);

async function open(url: string) {
  error.value = "";
  try {
    const browser = await openInBrowser(url);
    current = { browser, host: hostOf(url) };
    // 読み込み開始時: 背景色だけの最小 CSS(チラつき軽減。効かなくても無害)
    browser.addEventListener("loadstart", (e: IabEvent) => {
      const host = hostOf(e.url);
      if (current?.browser === browser) current.host = host;
      injectCss(browser, host, true);
    });
    // ページ読み込み完了のたびにテーマ CSS と ★ ボタンを注入(★ は注入側で二重注入を防止)
    browser.addEventListener("loadstop", (e: IabEvent) => {
      const host = hostOf(e.url);
      if (current?.browser === browser) current.host = host;
      injectCss(browser, host, false);
      browser.executeScript({ code: pageScriptCode() });
    });
    browser.addEventListener("message", (e: IabEvent) => {
      const d = e.data as PagePayload | undefined;
      if (d && d.type === "nb-save" && typeof d.url === "string") void handleSave(browser, d);
    });
    browser.addEventListener("exit", () => {
      if (current?.browser === browser) current = null;
      if (alive) void load(); // 閉じたら一覧を更新
    });
  } catch (e) {
    error.value = errorMessage(e);
  }
}
</script>

<template>
  <div class="row between">
    <h1>小説ビューア</h1>
    <button class="secondary small" @click="emit('settings')">設定</button>
  </div>

  <h2>サイトを開く</h2>
  <div class="row">
    <button v-for="s in SITES" :key="s.url" @click="open(s.url)">{{ s.name }}</button>
  </div>
  <p class="muted">開いたページの右下の ★ を押すとお気に入りに保存されます。</p>

  <div class="row between">
    <h2>お気に入り</h2>
    <button class="secondary small" :disabled="loading" @click="load">更新</button>
  </div>
  <p v-if="error" class="error">{{ error }}</p>
  <p v-if="!loading && !error && items.length === 0" class="muted">お気に入りはまだありません。</p>
  <div v-for="b in items" :key="b.id" class="card">
    <div @click="open(b.url)">
      <strong>{{ b.title || b.novelKey }}</strong>
      <div class="muted">{{ SITE_NAMES[b.site] ?? b.site }}<template v-if="b.author"> / {{ b.author }}</template></div>
    </div>
    <div class="row" style="margin-top: 8px">
      <button class="small" @click="open(b.url)">開く</button>
      <button class="small danger" @click="remove(b)">削除</button>
    </div>
  </div>
</template>
