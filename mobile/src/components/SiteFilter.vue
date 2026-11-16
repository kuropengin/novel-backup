<script setup lang="ts">
import { siteColor, type SiteId } from "../logic/sites";

/** サイトの絞り込みボタン(ALL / なろう / カクヨム / ハーメルン)。検索バーと同じ幅に均等に並べる。null = すべて */
const model = defineModel<SiteId | null>({ required: true });

const FILTERS: { id: SiteId | null; label: string }[] = [
  { id: null, label: "ALL" },
  { id: "narou", label: "なろう" },
  { id: "kakuyomu", label: "カクヨム" },
  { id: "hameln", label: "ハーメルン" },
];
</script>

<template>
  <div class="site-filter" role="group" aria-label="サイトで絞り込み">
    <button
      v-for="f in FILTERS"
      :key="f.label"
      class="chip"
      :class="{ active: model === f.id }"
      :style="f.id ? { '--c': siteColor(f.id) } : undefined"
      :aria-pressed="model === f.id"
      @click="model = f.id"
    >
      {{ f.label }}
    </button>
  </div>
</template>

<style scoped>
/* .searchbox と同じ左右の余白(16px)で、4 つを均等幅に並べる */
.site-filter { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; margin: 8px 16px 0; }
.chip { --c: var(--fg); min-width: 0; height: 32px; padding: 0 4px; border: 1px solid var(--border); border-radius: 999px; background: none; color: var(--fg); font-size: 13px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.chip.active { background: var(--c); border-color: var(--c); color: var(--bg); }
</style>
