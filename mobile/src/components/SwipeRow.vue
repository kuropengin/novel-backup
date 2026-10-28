<script setup lang="ts">
import { ref } from "vue";
import Icon from "./Icon.vue";

/**
 * 一覧の行。タップ → tap、長押し → long、左スワイプ(80px 以上)→ swipe を通知する。
 * 縦スクロールを妨げないよう、横方向の動きが優位なときだけ追従する。
 */
const props = defineProps<{ swipeable?: boolean }>();
const emit = defineEmits<{ (e: "tap"): void; (e: "long"): void; (e: "swipe"): void }>();

const LONG_MS = 550;
const MOVE_TOL = 10;
const SWIPE_PX = 80;

const dx = ref(0);
const dragging = ref(false);
let sx = 0;
let sy = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let touched = false;
let mode: "none" | "pending" | "swipe" | "scroll" | "long" = "none";

function clear() {
  clearTimeout(timer);
  timer = undefined;
}
function start(e: TouchEvent) {
  touched = true;
  const t = e.touches[0]!;
  sx = t.clientX;
  sy = t.clientY;
  mode = "pending";
  clear();
  timer = setTimeout(() => {
    if (mode === "pending") {
      mode = "long";
      emit("long");
    }
  }, LONG_MS);
}
function move(e: TouchEvent) {
  if (mode === "none" || mode === "long") return;
  const t = e.touches[0]!;
  const mx = t.clientX - sx;
  const my = t.clientY - sy;
  if (mode === "pending") {
    if (Math.abs(mx) < MOVE_TOL && Math.abs(my) < MOVE_TOL) return;
    clear();
    if (props.swipeable && mx < 0 && Math.abs(mx) > Math.abs(my) * 1.5) {
      mode = "swipe";
      dragging.value = true;
    } else {
      mode = "scroll";
      return;
    }
  }
  if (mode === "swipe") dx.value = Math.min(0, mx);
}
function end() {
  clear();
  if (mode === "pending") emit("tap");
  else if (mode === "swipe" && dx.value <= -SWIPE_PX) emit("swipe");
  mode = "none";
  dragging.value = false;
  dx.value = 0;
}
/** マウス操作(vite dev)用。タッチ操作では touchend 側で処理済み。 */
function click() {
  if (touched) {
    touched = false;
    return;
  }
  emit("tap");
}
function cancel() {
  clear();
  mode = "none";
  dragging.value = false;
  dx.value = 0;
}
</script>

<template>
  <div class="swipe-wrap">
    <div v-if="swipeable && dx < 0" class="swipe-bg"><Icon name="trash" /></div>
    <div
      :style="{ transform: `translateX(${dx}px)`, transition: dragging ? 'none' : 'transform 0.15s ease' }"
      @touchstart.passive="start"
      @touchmove.passive="move"
      @touchend="end"
      @touchcancel="cancel"
      @click="click"
      @contextmenu.prevent
    >
      <slot />
    </div>
  </div>
</template>
