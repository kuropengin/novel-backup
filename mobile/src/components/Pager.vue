<script setup lang="ts">
import { computed } from "vue";
import Icon from "./Icon.vue";
import { pageItems } from "../logic/lists";

/** ページ番号の切り替え(page は 1 始まり)。1 ページしか無いときは出さない */
const props = defineProps<{ page: number; pageCount: number; disabled?: boolean }>();
const emit = defineEmits<{ (e: "change", page: number): void }>();

const items = computed(() => pageItems(props.page, props.pageCount));

function go(p: number) {
  if (props.disabled || p < 1 || p > props.pageCount || p === props.page) return;
  emit("change", p);
}
</script>

<template>
  <nav v-if="pageCount > 1" class="pager" aria-label="ページ">
    <button class="nav" :disabled="disabled || page <= 1" aria-label="前のページ" @click="go(page - 1)"><Icon name="chevron-left" :size="18" /></button>
    <template v-for="(it, i) in items" :key="`${i}-${it}`">
      <span v-if="it === 'gap'" class="gap">…</span>
      <button v-else class="num" :class="{ active: it === page }" :aria-current="it === page ? 'page' : undefined" :disabled="disabled" @click="go(it)">
        {{ it }}
      </button>
    </template>
    <button class="nav" :disabled="disabled || page >= pageCount" aria-label="次のページ" @click="go(page + 1)"><Icon name="chevron-right" :size="18" /></button>
  </nav>
</template>

<style scoped>
.pager { display: flex; align-items: center; justify-content: center; gap: 4px; padding: 16px; }
.pager button { min-width: 36px; height: 36px; padding: 0 6px; border: 1px solid var(--border); border-radius: 999px; background: none; color: var(--fg); font-size: 14px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; }
.pager button.active { background: var(--fg); border-color: var(--fg); color: var(--bg); }
.pager button:disabled:not(.active) { opacity: 0.4; }
.gap { min-width: 20px; text-align: center; color: var(--muted); }
</style>
