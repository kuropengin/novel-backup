<script setup lang="ts">
import { computed, ref } from "vue";
import { useReaderSettings } from "../composables/readerSettings";

const props = defineProps<{
  title: string;
  prefaceHtml?: string;
  bodyHtml: string;
  afterwordHtml?: string;
}>();

const s = useReaderSettings();
const panel = ref(false);

/** 本文 HTML を表示用に整える: 危険要素の除去と img src の /proxy/img 化。 */
function prepare(html: string | undefined): string {
  if (!html) return "";
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script, iframe, object, embed, style, link, meta, base").forEach((e) => e.remove());
  doc.querySelectorAll("*").forEach((el) => {
    for (const a of Array.from(el.attributes)) {
      if (/^on/i.test(a.name)) el.removeAttribute(a.name);
    }
    if (el.tagName === "A") {
      const href = el.getAttribute("href") ?? "";
      if (/^\s*javascript:/i.test(href)) el.removeAttribute("href");
      else {
        el.setAttribute("target", "_blank");
        el.setAttribute("rel", "noopener noreferrer");
      }
    }
  });
  doc.querySelectorAll("img").forEach((img) => {
    const src = img.getAttribute("src") ?? "";
    img.removeAttribute("srcset");
    img.setAttribute("loading", "lazy");
    if (/^https?:\/\//i.test(src)) img.setAttribute("src", `/proxy/img?url=${encodeURIComponent(src)}`);
    else if (!src.startsWith("/proxy/img?")) img.removeAttribute("src");
  });
  return doc.body.innerHTML;
}

const preface = computed(() => prepare(props.prefaceHtml));
const body = computed(() => prepare(props.bodyHtml));
const afterword = computed(() => prepare(props.afterwordHtml));

const bodyStyle = computed(() => ({
  fontSize: `${s.fontSize}px`,
  lineHeight: String(s.lineHeight),
}));
</script>

<template>
  <div class="reader" :class="[`theme-${s.theme}`, `font-${s.font}`, { vertical: s.vertical }]">
    <div class="reader-bar">
      <slot name="header" />
      <button class="secondary small settings-btn" :aria-expanded="panel" @click="panel = !panel">表示設定</button>
    </div>
    <div v-if="panel" class="reader-panel">
      <label>
        文字サイズ {{ s.fontSize }}px
        <input v-model.number="s.fontSize" type="range" min="12" max="36" step="1" />
      </label>
      <label>
        行間 {{ s.lineHeight.toFixed(1) }}
        <input v-model.number="s.lineHeight" type="range" min="1.2" max="3" step="0.1" />
      </label>
      <label>
        書体
        <select v-model="s.font">
          <option value="mincho">明朝</option>
          <option value="gothic">ゴシック</option>
        </select>
      </label>
      <label>
        テーマ
        <select v-model="s.theme">
          <option value="light">ライト</option>
          <option value="sepia">セピア</option>
          <option value="dark">ダーク</option>
        </select>
      </label>
      <label class="check"><input v-model="s.vertical" type="checkbox" /> 縦書き</label>
    </div>

    <article class="reader-article" :style="bodyStyle">
      <h2 class="ep-title">{{ title }}</h2>
      <section v-if="preface" class="preface" v-html="preface" />
      <section class="honbun" v-html="body" />
      <section v-if="afterword" class="afterword" v-html="afterword" />
    </article>
    <div class="reader-footer"><slot name="footer" /></div>
  </div>
</template>

<style scoped>
.reader { border-radius: 10px; padding: 12px 16px 20px; --r-bg: #fff; --r-fg: #232629; --r-line: #dde1e4; background: var(--r-bg); color: var(--r-fg); }
.theme-sepia { --r-bg: #f4ecd8; --r-fg: #433422; --r-line: #d9ccaa; }
.theme-dark { --r-bg: #16181a; --r-fg: #cfd3d6; --r-line: #33393d; }
.font-mincho .reader-article { font-family: "Hiragino Mincho ProN", "Yu Mincho", "YuMincho", "MS PMincho", serif; }
.font-gothic .reader-article { font-family: system-ui, "Hiragino Sans", "Yu Gothic", "Meiryo", sans-serif; }
.reader-bar { display: flex; gap: 8px; align-items: center; justify-content: space-between; flex-wrap: wrap; margin-bottom: 8px; }
.settings-btn { color: inherit; border-color: var(--r-line); margin-left: auto; }
.reader-panel { display: flex; flex-wrap: wrap; gap: 12px 20px; padding: 10px 12px; margin-bottom: 12px; border: 1px solid var(--r-line); border-radius: 8px; font-size: 14px; }
.reader-panel label { display: flex; flex-direction: column; gap: 2px; min-width: 120px; }
.reader-panel label.check { flex-direction: row; align-items: center; gap: 6px; }
.reader-panel input[type="range"] { padding: 0; }
.ep-title { font-size: 1.15em; margin: 8px 0 16px; }
.reader-article { max-width: 46em; margin: 0 auto; overflow-wrap: anywhere; }
.preface, .afterword { opacity: 0.85; border-left: 3px solid var(--r-line); padding-left: 10px; margin: 12px 0; }
.afterword { margin-top: 24px; }
.reader-footer { margin-top: 20px; }

.vertical .reader-article {
  writing-mode: vertical-rl;
  text-orientation: mixed;
  max-width: none;
  margin: 0;
  height: calc(100dvh - 190px);
  min-height: 320px;
  overflow-x: auto;
  overflow-y: hidden;
  padding: 4px;
}
.vertical .ep-title { margin: 0 0 0 20px; }
</style>

<style>
.reader-article p { margin: 0 0 0.2em; }
.reader-article img { max-width: 100%; height: auto; }
.vertical .reader-article img { max-height: 100%; width: auto; }
.reader-article a { color: inherit; }
.reader-article ruby rt { font-size: 0.5em; }
</style>
