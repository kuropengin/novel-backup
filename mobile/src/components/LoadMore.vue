<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, watch } from "vue";

/**
 * 一覧末尾に置く順次読み込みの番兵。画面に近づいたら more を通知する(スクロールで次のページを読む)。
 * 読み込み後も番兵が見えたまま(1 ページが画面より短い)なら続けて通知する。失敗時は自動では再試行せずボタンを出す。
 */
const props = defineProps<{ loading: boolean; done: boolean; error?: string }>();
const emit = defineEmits<{ (e: "more"): void }>();

const el = ref<HTMLElement | null>(null);
let visible = false;
let observer: IntersectionObserver | null = null;

function request() {
  if (visible && !props.loading && !props.done && !props.error) emit("more");
}

onMounted(() => {
  observer = new IntersectionObserver(
    (entries) => {
      visible = entries.some((e) => e.isIntersecting);
      request();
    },
    { rootMargin: "300px 0px" },
  );
  if (el.value) observer.observe(el.value);
});
onUnmounted(() => observer?.disconnect());
watch(
  () => [props.loading, props.done],
  () => void nextTick(request),
);
</script>

<template>
  <div ref="el" class="load-more">
    <template v-if="error">
      <span class="error">{{ error }}</span>
      <button class="btn secondary small" @click="emit('more')">再読み込み</button>
    </template>
    <span v-else-if="loading" class="muted">読み込み中...</span>
  </div>
</template>

<style scoped>
.load-more { display: flex; flex-direction: column; align-items: center; gap: 8px; min-height: 1px; padding: 12px 16px; text-align: center; font-size: 13px; }
.load-more:empty { padding: 0; }
</style>
