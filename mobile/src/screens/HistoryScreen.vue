<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import Icon from "../components/Icon.vue";
import Pager from "../components/Pager.vue";
import SiteFilter from "../components/SiteFilter.vue";
import SwipeRow from "../components/SwipeRow.vue";
import { ApiError, deleteHistory, deleteHistoryNovel, errorMessage, listHistory, type HistoryItem } from "../api";
import type { Settings } from "../storage";
import { confirmNative } from "../native/dialogs";
import { relativeTime } from "../logic/lists";
import { siteColor, siteLabel, type SiteId } from "../logic/sites";

/** 1 ページの件数 */
const PAGE = 30;

const props = defineProps<{ settings: Settings }>();
const emit = defineEmits<{ (e: "open", url: string): void; (e: "unauthorized"): void }>();

const view = ref<"episode" | "novel">("episode");
const q = ref("");
/** サイトの絞り込み(null = すべて) */
const siteFilter = ref<SiteId | null>(null);
const items = ref<HistoryItem[]>([]);
/** サーバー側の(絞り込み後の)全件数 */
const total = ref(0);
/** 表示中のページ(1 始まり) */
const page = ref(1);
const pageCount = computed(() => Math.max(1, Math.ceil(total.value / PAGE)));
const loading = ref(true);
const error = ref("");
const cfg = () => ({ serverUrl: props.settings.serverUrl, token: props.settings.token });

// 表示・検索語・サイト・ページが変わったら古い応答を捨てる
let seq = 0;
/** 表示中のページを取得する。silent は削除後の更新用(表示を消さない) */
async function load(silent = false) {
  const my = ++seq;
  if (!silent) loading.value = true;
  error.value = "";
  try {
    const r = await listHistory(cfg(), {
      view: view.value,
      q: q.value,
      site: siteFilter.value ?? undefined,
      limit: PAGE,
      offset: (page.value - 1) * PAGE,
    });
    if (my !== seq) return;
    // 削除などで今のページが無くなったら最後のページを出す
    if (r.history.length === 0 && r.total > 0 && page.value > 1) {
      page.value = Math.ceil(r.total / PAGE);
      return void load(silent);
    }
    items.value = r.history;
    total.value = r.total;
  } catch (e) {
    if (my !== seq) return;
    if (e instanceof ApiError && e.status === 401) emit("unauthorized");
    else error.value = errorMessage(e);
  } finally {
    if (my === seq) loading.value = false;
  }
}

/** 条件(表示・検索語・サイト)を変えたら 1 ページ目から */
function reloadFromFirst() {
  page.value = 1;
  void load();
}
function goPage(p: number) {
  page.value = p;
  window.scrollTo(0, 0);
  void load();
}

onMounted(load);
watch([view, siteFilter], () => {
  items.value = [];
  reloadFromFirst();
});
let timer: ReturnType<typeof setTimeout> | undefined;
watch(q, () => {
  clearTimeout(timer);
  timer = setTimeout(reloadFromFirst, 300);
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
    // 消した行をすぐ外し、空いた分を次のページから詰めるために今のページを取り直す
    items.value = items.value.filter((x) => (novel ? !(x.site === h.site && x.novelKey === h.novelKey) : x.id !== h.id));
    await load(true);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) emit("unauthorized");
    else error.value = errorMessage(e);
  }
}
</script>

<template>
  <div>
    <SiteFilter v-model="siteFilter" />
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
    <div v-if="!loading && total > 0" class="toolbar"><span class="muted">{{ total }} 件</span></div>
    <p v-if="error" class="error page">{{ error }}</p>
    <div v-if="!loading && items.length === 0 && !error" class="empty">
      <div class="big">{{ q || siteFilter ? "一致する履歴がありません" : "閲覧履歴はまだありません" }}</div>
      <template v-if="!q && !siteFilter">サイトで作品や話を開くと記録されます。</template>
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
    <Pager v-if="items.length > 0" :page="page" :page-count="pageCount" :disabled="loading" @change="goPage" />
  </div>
</template>
