<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from "vue";
import Icon from "../components/Icon.vue";
import SwipeRow from "../components/SwipeRow.vue";
import { ApiError, deleteHistory, deleteHistoryNovel, errorMessage, listHistory, type HistoryItem } from "../api";
import type { Settings } from "../storage";
import { confirmNative } from "../native/dialogs";
import { relativeTime } from "../logic/lists";
import { siteColor, siteLabel } from "../logic/sites";

const props = defineProps<{ settings: Settings }>();
const emit = defineEmits<{ (e: "open", url: string): void; (e: "unauthorized"): void }>();

const view = ref<"episode" | "novel">("episode");
const q = ref("");
const items = ref<HistoryItem[]>([]);
const loading = ref(true);
const error = ref("");
const cfg = () => ({ serverUrl: props.settings.serverUrl, token: props.settings.token });

let seq = 0;
async function load() {
  const my = ++seq;
  loading.value = true;
  error.value = "";
  try {
    const r = await listHistory(cfg(), view.value, q.value);
    if (my === seq) items.value = r;
  } catch (e) {
    if (my !== seq) return;
    if (e instanceof ApiError && e.status === 401) emit("unauthorized");
    else error.value = errorMessage(e);
  } finally {
    if (my === seq) loading.value = false;
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
    await load();
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
  </div>
</template>
