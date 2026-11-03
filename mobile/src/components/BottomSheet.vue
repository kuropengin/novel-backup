<script setup lang="ts">
import { onUnmounted, watch } from "vue";
import { pushOverlay } from "../stores/overlays";

const props = defineProps<{ open: boolean; title?: string }>();
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
    <div v-if="open" class="sheet" role="dialog" :aria-label="title">
      <div class="grab" />
      <h3 v-if="title">{{ title }}</h3>
      <slot />
    </div>
  </Transition>
</template>
