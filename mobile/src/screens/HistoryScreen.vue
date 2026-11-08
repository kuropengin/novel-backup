<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from "vue";
import Icon from "../components/Icon.vue";
import LoadMore from "../components/LoadMore.vue";
import SwipeRow from "../components/SwipeRow.vue";
import { ApiError, deleteHistory, deleteHistoryNovel, errorMessage, listHistory, type HistoryItem } from "../api";
import type { Settings } from "../storage";
import { confirmNative } from "../native/dialogs";
import { relativeTime } from "../logic/lists";
import { siteColor, siteLabel } from "../logic/sites";

/** 1 回に読み込む件数(スクロールで続きを読む) */
const PAGE = 30;

const props = defineProps<{ settings: Settings }>();
const emit = defineEmits<{ (e: "open", url: string): void; (e: "unauthorized"): void }>();

const view = ref<"episode" | "novel">("episode");
const q = ref("");
const items = ref<HistoryItem[]>([]);
const loading = ref(true);
const loadingMore = ref(false);
const done = ref(false);
const error = ref("");
const moreError = ref("");
const cfg = () => ({ serverUrl: props.settings.serverUrl, token: props.settings.token });

// 表示・検索語が変わったら古い応答を捨てる
let seq = 0;
async function load() {
  const my = ++seq;
  loading.value = true;
  error.value = "";
  moreError.value = "";
  try {
    const r = await listHistory(cfg(), view.value, q.value, PAGE, 0);
    if (my !== seq) return;
    items.value = r;
    done.value = r.length < PAGE;
  } catch (e) {
    if (my !== seq) return;
    if (e instanceof ApiError && e.status === 401) emit("unauthorized");
    else error.value = errorMessage(e);
  } finally {
    if (my === seq) loading.value = false;
  }
}

async function more() {
  if (loading.value || loadingMore.value || done.value) return;
  const my = seq;
  loadingMore.value = true;
  moreError.value = "";
  try {
    const r = await listHistory(cfg(), view.value, q.value, PAGE, items.value.length);
    if (my !== seq) return;
    const known = new Set(items.value.map((h) => h.id));
    items.value = [...items.value, ...r.filter((h) => !known.has(h.id))];
    done.value = r.length < PAGE;
  } catch (e) {
    if (my !== seq) return;
    if (e instanceof ApiError && e.status === 401) emit("unauthorized");
    else moreError.value = errorMessage(e);
  } finally {
    loadingMore.value = false;
  }
}

onMounted(load);
watch(view, () => {
  items.value = [];
  void load();
});
let timer: ReturnType<typeof setTimeout> | undefined;
watch(q, () => {
  clearTimeout(timer);
  timer = setTimeout(load, 300);
});
onUnmounted(() => clearTimeout(timer));

async function remove(h: HistoryItem) {
  const novel = view.value === "novel";
  const msg = novel
    ? `「${h.novelTitle || h.novelKey}」の閲覧履歴をすべて削除しますか?`
    : `この閲覧履歴を削除しますか?\n${h.novelTitle}${h.episodeTitle ? " / " + h.episodeTitle : ""}`;
  if (!(await confirmNative(msg, "履歴の削除", "削除"))) return;
  try {
    if (novel) await deleteHistoryNovel(cfg(), h.site, h.novelKey);
    else await deleteHistory(cfg(), h.id);
    // 読み込み済みのページを保ったまま、消した行だけ取り除く
    items.value = items.value.filter((x) => (novel ? !(x.site === h.site && x.novelKey === h.novelKey) : x.id !== h.id));
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) emit("unauthorized");
    else error.value = errorMessage(e);
  }
}
</script>

<template>
  <div>
    <label class="searchbox">
      <Icon name="search" :size="18" />
      <input v-model="q" type="search" placeholder="作品名・話タイトルで検索" autocapitalize="off" />
    </label>
    <div class="page" style="margin: 4px 0 8px">
      <div class="seg">
        <button :class="{ active: view === 'episode' }" @click="view = 'episode'">エピソード毎</button>
        <button :class="{ active: view === 'novel' }" @click="view = 'novel'">作品毎</button>
      </div>
    </div>
    <p v-if="error" class="error page">{{ error }}</p>
    <div v-if="!loading && items.length === 0 && !error" class="empty">
      <div class="big">{{ q ? "一致する履歴がありません" : "閲覧履歴はまだありません" }}</div>
      <template v-if="!q">サイトで作品や話を開くと記録されます。</template>
    </div>
    <SwipeRow v-for="h in items" :key="h.id" @tap="emit('open', h.url)" @long="remove(h)">
      <div class="list-row">
        <div class="main">
          <div class="title"><span class="site-badge" :style="{ background: siteColor(h.site) }">{{ siteLabel(h.site) }}</span>{{ h.novelTitle || h.novelKey }}</div>
          <div class="sub">{{ h.episodeKey ? h.episodeTitle || "話ページ" : "作品ページ" }}</div>
          <div class="meta">
            <template v-if="view === 'novel' && h.episodeCount">{{ h.episodeCount }} 話閲覧 ・ </template>{{ relativeTime(h.viewedAt) }}
          </div>
        </div>
      </div>
    </SwipeRow>
    <LoadMore v-if="!loading && items.length > 0" :loading="loadingMore" :done="done" :error="moreError" @more="more" />
  </div>
</template>
