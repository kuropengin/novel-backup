<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import Icon from "../components/Icon.vue";
import BottomSheet from "../components/BottomSheet.vue";
import SwipeRow from "../components/SwipeRow.vue";
import { ApiError, deleteBookmark, errorMessage, listBookmarks, type Bookmark } from "../api";
import type { Settings } from "../storage";
import { confirmNative } from "../native/dialogs";
import { online } from "../stores/network";
import { filterBookmarks, formatDate, offlineOnly, sortBookmarks, SORT_OPTIONS, type SortKey, type SortOrder } from "../logic/lists";
import { siteColor, siteLabel } from "../logic/sites";

const props = defineProps<{ settings: Settings }>();
const emit = defineEmits<{ (e: "open", url: string): void; (e: "unauthorized"): void }>();

const items = ref<Bookmark[]>([]);
const loading = ref(true);
const error = ref("");
const q = ref("");
const sortKey = ref<SortKey>("added");
const order = ref<SortOrder>("desc");
const sheet = ref(false);

const cfg = () => ({ serverUrl: props.settings.serverUrl, token: props.settings.token });

const visible = computed(() => {
  // オフライン時は端末に保存済みの作品だけ(今回は保存機能が無いので空)
  const base = online.value ? items.value : offlineOnly(items.value);
  return sortBookmarks(filterBookmarks(base, q.value), sortKey.value, order.value);
});
const sortLabel = computed(() => `${SORT_OPTIONS.find((o) => o.key === sortKey.value)?.label ?? ""}${order.value === "desc" ? " ↓" : " ↑"}`);

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

async function remove(b: Bookmark) {
  if (!(await confirmNative(`「${b.title || b.novelKey}」をお気に入りから削除しますか?`, "削除", "削除"))) return;
  try {
    await deleteBookmark(cfg(), b.id);
    items.value = items.value.filter((x) => x.id !== b.id);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) emit("unauthorized");
    else error.value = errorMessage(e);
  }
}

function pick(key: SortKey) {
  if (key === sortKey.value) order.value = order.value === "desc" ? "asc" : "desc";
  else {
    sortKey.value = key;
    order.value = key === "title" || key === "site" ? "asc" : "desc";
  }
}
</script>

<template>
  <div>
    <label class="searchbox">
      <Icon name="search" :size="18" />
      <input v-model="q" type="search" placeholder="タイトル・作者・サイトで検索" autocapitalize="off" />
    </label>
    <div class="toolbar">
      <span class="muted">{{ visible.length }} 件</span>
      <button class="btn secondary small sort-btn" @click="sheet = true"><Icon name="sort" :size="16" />{{ sortLabel }}</button>
    </div>
    <div v-if="!online" class="banner">オフライン中: オフライン保存済みの作品のみ表示します。</div>
    <p v-if="error" class="error page">{{ error }}</p>

    <div v-if="!loading && visible.length === 0 && !error" class="empty">
      <template v-if="!online">
        <div class="big">オフライン保存された作品はありません</div>
        オフライン保存は今後対応予定です。
      </template>
      <template v-else-if="items.length === 0">
        <div class="big">お気に入りはまだありません</div>
        作品のページを開いて、下の ★ ボタンで追加できます。
      </template>
      <template v-else><div class="big">一致する作品がありません</div></template>
    </div>

    <SwipeRow v-for="b in visible" :key="b.id" swipeable @tap="emit('open', b.url)" @long="remove(b)" @swipe="remove(b)">
      <div class="list-row">
        <div class="main">
          <div class="title"><span class="site-badge" :style="{ background: siteColor(b.site) }">{{ siteLabel(b.site) }}</span>{{ b.title || b.novelKey }}</div>
          <div v-if="b.author" class="sub">{{ b.author }}</div>
          <div class="meta">追加 {{ formatDate(b.createdAt) }}</div>
        </div>
        <!-- バックアップ / オフライン保存の状態(今回はデザインのみ。常に「なし」のグレー) -->
        <div class="status">
          <span title="バックアップ: なし"><Icon name="cloud" :size="20" /></span>
          <span title="オフライン保存: なし"><Icon name="download" :size="20" /></span>
        </div>
      </div>
    </SwipeRow>

    <BottomSheet :open="sheet" title="並べ替え" @close="sheet = false">
      <button v-for="o in SORT_OPTIONS" :key="o.key" class="sheet-option" :class="{ active: sortKey === o.key }" @click="pick(o.key)">
        <span>{{ o.label }}<span v-if="o.note" class="note">{{ o.note }}</span></span>
        <span v-if="sortKey === o.key">{{ order === "desc" ? "降順 ↓" : "昇順 ↑" }}</span>
      </button>
      <p class="muted">同じ項目をもう一度選ぶと昇順・降順が切り替わります。</p>
    </BottomSheet>
  </div>
</template>
