<script setup lang="ts">
import { onMounted, ref } from "vue";
import { ApiError, errorMessage, listHistory, type HistoryItem } from "../api";
import type { Settings } from "../storage";
import { relativeTime } from "../logic/lists";
import { siteColor, siteLabel, type SiteId } from "../logic/sites";

const props = defineProps<{ settings: Settings }>();
const emit = defineEmits<{ (e: "open", url: string): void; (e: "unauthorized"): void }>();

const SITES: { id: SiteId; name: string; url: string; desc: string }[] = [
  { id: "narou", name: "小説家になろう", url: "https://yomou.syosetu.com/", desc: "yomou.syosetu.com" },
  { id: "kakuyomu", name: "カクヨム", url: "https://kakuyomu.jp/", desc: "kakuyomu.jp" },
  { id: "hameln", name: "ハーメルン", url: "https://syosetu.org/", desc: "syosetu.org" },
];

const items = ref<HistoryItem[]>([]);
const loading = ref(true);
const error = ref("");

onMounted(async () => {
  try {
    items.value = await listHistory({ serverUrl: props.settings.serverUrl, token: props.settings.token }, "novel", "", 30);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) emit("unauthorized");
    else error.value = errorMessage(e);
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div>
    <div class="site-cards">
      <button v-for="s in SITES" :key="s.id" class="site-card" :style="{ '--c': siteColor(s.id) }" @click="emit('open', s.url)">
        <div>
          <div class="name">{{ s.name }}</div>
          <div class="muted">{{ s.desc }}</div>
        </div>
      </button>
    </div>

    <div class="section-title">閲覧作品</div>
    <p v-if="error" class="error page">{{ error }}</p>
    <div v-else-if="!loading && items.length === 0" class="empty">
      <div class="big">閲覧作品はまだありません</div>
      サイトで作品を開くと、ここに表示されます。
    </div>
    <button v-for="h in items" :key="h.id" class="list-row row-btn" @click="emit('open', h.url)">
      <div class="main">
        <div class="title"><span class="site-badge" :style="{ background: siteColor(h.site) }">{{ siteLabel(h.site) }}</span>{{ h.novelTitle || h.novelKey }}</div>
        <div class="sub">{{ h.episodeKey ? h.episodeTitle || "最後に読んだ話" : "作品ページ" }}</div>
        <div class="meta">{{ relativeTime(h.viewedAt) }}</div>
      </div>
    </button>
  </div>
</template>
