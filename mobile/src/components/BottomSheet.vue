<script setup lang="ts">
import { onUnmounted, watch } from "vue";
import { pushOverlay } from "../stores/overlays";

/** height を指定すると高さを固定し、中身(slot)の側でスクロールする(例: "70vh")。label は見出しなしのときの読み上げ名 */
const props = defineProps<{ open: boolean; title?: string; label?: string; height?: string }>();
const emit = defineEmits<{ (e: "close"): void }>();

let release: (() => void) | null = null;
let openedAt = 0;
// 開いたタップ自身の合成 click が scrim に当たって即閉じるのを防ぐ
function onScrimClick() {
  if (Date.now() - openedAt < 400) return;
  emit("close");
}
watch(
  () => props.open,
  (o) => {
    if (o) openedAt = Date.now();
    release?.();
    release = o ? pushOverlay(() => emit("close")) : null;
  },
  { immediate: true },
);
onUnmounted(() => release?.());
</script>

<template>
  <Transition name="fade">
    <div v-if="open" class="scrim" @click="onScrimClick" />
  </Transition>
  <Transition name="slide-up">
    <div v-if="open" class="sheet" :class="{ fixed: !!height }" :style="height ? { height } : undefined" role="dialog" :aria-label="title ?? label">
      <div class="grab" />
      <h3 v-if="title">{{ title }}</h3>
      <slot />
    </div>
  </Transition>
</template>
