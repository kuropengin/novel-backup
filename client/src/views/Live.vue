<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { bookmarksApi, liveApi } from "../api";
import { errorMessage } from "../api/client";
import type { ResolvedUrl, SiteId, SiteInfo } from "../api/types";

const router = useRouter();
const sites = ref<SiteInfo[]>([]);
const site = ref<SiteId>("narou");
const frame = ref<HTMLIFrameElement | null>(null);
const urlInput = ref("");
const resolved = ref<ResolvedUrl | null>(null);
const error = ref("");
const busy = ref(false);
const loading = ref(false);
const frameSrc = ref("");
let resolveSeq = 0;

const LAST_KEY = "nb.liveLast";
const SITE_KEY = "nb.liveSite";

function lsGet(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function lsSet(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* ignore */
  }
}

function defaultPath(s: SiteInfo): string {
  return `/proxy/${s.site}/${s.defaultHost}/`;
}

onMounted(async () => {
  try {
    sites.value = (await liveApi.sites()).sites;
  } catch (e) {
    error.value = errorMessage(e);
    return;
  }
  const savedSite = lsGet(SITE_KEY);
  const initial = sites.value.find((s) => s.site === savedSite) ?? sites.value.find((s) => s.site === "narou") ?? sites.value[0]!;
  site.value = initial.site;
  const last = lsGet(LAST_KEY);
  loading.value = true;
  frameSrc.value = last && last.startsWith(`/proxy/${initial.site}/`) ? last : defaultPath(initial);
});

function selectSite(s: SiteInfo) {
  site.value = s.site;
  lsSet(SITE_KEY, s.site);
  error.value = "";
  navigate(defaultPath(s));
}

function navigate(path: string) {
  loading.value = true;
  if (frame.value) frame.value.src = path;
  else frameSrc.value = path;
}

/** `/proxy/{site}/{host}/{rest}` を元サイト URL にする */
function originalUrl(path: string): string | null {
  const m = /^\/proxy\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path);
  return m ? `https://${m[2]}${m[3] ?? "/"}` : null;
}

function toProxyPath(input: string): string | null {
  const t = input.trim();
  if (t.startsWith("/proxy/")) return t;
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(t) ? t : `https://${t}`);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const s = sites.value.find((x) => x.hosts.some((h) => h.replace(/^www\./, "") === host));
  return s ? `/proxy/${s.site}/${u.hostname.toLowerCase()}${u.pathname}${u.search}` : null;
}

function go() {
  error.value = "";
  const p = toProxyPath(urlInput.value);
  if (!p) {
    error.value = "対応していないサイトの URL です(ハーメルン / なろう / カクヨムのみ)";
    return;
  }
  navigate(p);
}

async function onLoad() {
  loading.value = false;
  let path = "";
  try {
    const loc = frame.value?.contentWindow?.location;
    if (!loc) return;
    path = loc.pathname + loc.search;
  } catch {
    return;
  }
  if (!path.startsWith("/proxy/")) return;
  const orig = originalUrl(path);
  if (orig) urlInput.value = orig;
  const m = /^\/proxy\/([^/]+)\//.exec(path);
  if (m && sites.value.some((s) => s.site === m[1])) {
    site.value = m[1] as SiteId;
    lsSet(SITE_KEY, site.value);
  }
  lsSet(LAST_KEY, path);
  const seq = ++resolveSeq;
  try {
    const r = await liveApi.resolve(path);
    if (seq === resolveSeq) resolved.value = r;
  } catch {
    if (seq === resolveSeq) resolved.value = null;
  }
}

function withWin(fn: (w: Window) => void) {
  const w = frame.value?.contentWindow;
  if (!w) return;
  try {
    fn(w);
  } catch {
    /* cross-origin など */
  }
}
const back = () => withWin((w) => w.history.back());
const forward = () => withWin((w) => w.history.forward());
const reload = () => withWin((w) => w.location.reload());

async function toggleBookmark() {
  const r = resolved.value;
  if (!r) return;
  busy.value = true;
  error.value = "";
  try {
    if (r.bookmarked && r.bookmarkId !== null) {
      await bookmarksApi.remove(r.bookmarkId);
      resolved.value = { ...r, bookmarked: false, bookmarkId: null };
    } else {
      const res = await bookmarksApi.create(r.site, r.novelKey);
      resolved.value = { ...r, bookmarked: true, bookmarkId: res.bookmark.id };
    }
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}

function openReader() {
  const r = resolved.value;
  if (!r) return;
  if (r.episodeKey) router.push({ name: "live-episode", params: { site: r.site, novelKey: r.novelKey, episodeKey: r.episodeKey } });
  else router.push({ name: "live-novel", params: { site: r.site, novelKey: r.novelKey } });
}

const kindLabel = computed(() => (resolved.value?.episodeKey ? "話ページ" : "作品ページ"));
</script>

<template>
  <div class="live">
    <div class="site-tabs" role="tablist">
      <button
        v-for="s in sites"
        :key="s.site"
        role="tab"
        class="secondary small"
        :class="{ active: s.site === site }"
        :aria-selected="s.site === site"
        @click="selectSite(s)"
      >
        {{ s.displayName }}
      </button>
    </div>

    <div class="toolbar">
      <div class="nav-btns">
        <button class="secondary small" title="戻る" @click="back">←</button>
        <button class="secondary small" title="進む" @click="forward">→</button>
        <button class="secondary small" title="再読込" @click="reload">⟳</button>
      </div>
      <form class="url-form" @submit.prevent="go">
        <input v-model="urlInput" type="text" inputmode="url" placeholder="サイトの URL を貼り付けて移動" aria-label="URL" />
        <button class="small" type="submit">移動</button>
      </form>
    </div>

    <div v-if="resolved" class="toolbar found">
      <span class="muted">{{ kindLabel }}を表示中</span>
      <button class="small" :class="{ secondary: resolved.bookmarked }" :disabled="busy" @click="toggleBookmark">
        {{ resolved.bookmarked ? "ブックマーク済み(解除)" : "ブックマークに追加" }}
      </button>
      <button class="small secondary" @click="openReader">リーダーで開く</button>
    </div>
    <p v-if="error" class="error">{{ error }}</p>

    <iframe
      v-if="frameSrc"
      ref="frame"
      class="browse-frame"
      :src="frameSrc"
      sandbox="allow-same-origin allow-forms allow-popups"
      referrerpolicy="no-referrer"
      title="ライブ閲覧"
      @load="onLoad"
    />
    <p v-if="loading" class="muted">読み込み中…</p>
  </div>
</template>

<style scoped>
.live { display: flex; flex-direction: column; gap: 8px; height: calc(100dvh - 48px); min-height: 400px; }
.site-tabs { display: flex; gap: 6px; flex-wrap: wrap; }
.site-tabs button.active { background: var(--c-primary); color: var(--c-primary-text); }
.toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.nav-btns { display: flex; gap: 4px; }
.url-form { display: flex; gap: 6px; flex: 1; min-width: 200px; }
.url-form input { flex: 1; }
.found { background: var(--c-surface); border: 1px solid var(--c-border); border-radius: 8px; padding: 6px 10px; }
.browse-frame { flex: 1; width: 100%; min-height: 300px; border: 1px solid var(--c-border); border-radius: 8px; background: #fff; }
@media (max-width: 767px) {
  .live { height: calc(100dvh - var(--tabbar-h) - 32px - env(safe-area-inset-bottom)); }
}
</style>
