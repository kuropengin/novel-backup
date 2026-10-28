<script setup lang="ts">
import { onUnmounted, watch } from "vue";
import { pushOverlay } from "../stores/overlays";

const props = defineProps<{ open: boolean; title?: string }>();
const emit = defineEmits<{ (e: "close"): void }>();

let release: (() => void) | null = null;
watch(
  () => props.open,
  (o) => {
    release?.();
    release = o ? pushOverlay(() => emit("close")) : null;
  },
  { immediate: true },
);
onUnmounted(() => release?.());
</script>

<template>
  <Transition name="fade">
    <div v-if="open" class="scrim" @click="emit('close')" />
  </Transition>
  <Transition name="slide-up">
    <div v-if="open" class="sheet" role="dialog" :aria-label="title">
      <div class="grab" />
      <h3 v-if="title">{{ title }}</h3>
      <slot />
    </div>
  </Transition>
</template>
