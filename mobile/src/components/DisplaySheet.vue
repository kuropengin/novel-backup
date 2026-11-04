<script setup lang="ts">
import { computed } from "vue";
import BottomSheet from "./BottomSheet.vue";
import { FONT_SIZES_PX, fontStackOf, LINE_HEIGHTS, type DisplaySettings } from "../display";

/** 「Aa」: 本文の表示設定(フォント・文字サイズ・行間)。各サイトの話ページの本文にだけ適用される。 */
const props = defineProps<{ open: boolean; display: DisplaySettings }>();
const emit = defineEmits<{ (e: "close"): void; (e: "change", d: DisplaySettings): void }>();

function set(patch: Partial<DisplaySettings>) {
  emit("change", { ...props.display, ...patch });
}
const previewStyle = computed(() => ({
  fontSize: FONT_SIZES_PX[props.display.fontSize - 1] + "px",
  lineHeight: String(props.display.lineHeight),
  fontFamily: fontStackOf(props.display.font),
}));
const sizes = [1, 2, 3, 4, 5] as const;
</script>

<template>
  <BottomSheet :open="open" title="本文の表示" @close="emit('close')">
    <div class="group-label">フォント</div>
    <div class="seg">
      <button :class="{ active: display.font === 'mincho' }" @click="set({ font: 'mincho' })">明朝</button>
      <button :class="{ active: display.font === 'gothic' }" @click="set({ font: 'gothic' })">ゴシック</button>
      <button :class="{ active: display.font === 'site' }" @click="set({ font: 'site' })">変更しない<br /><span class="seg-note">(サイト依存)</span></button>
    </div>
    <div class="group-label">文字サイズ({{ FONT_SIZES_PX[display.fontSize - 1] }}px)</div>
    <div class="seg">
      <button v-for="s in sizes" :key="s" :class="{ active: display.fontSize === s }" :style="{ fontSize: 10 + s * 2 + 'px' }" @click="set({ fontSize: s })">あ</button>
    </div>
    <div class="group-label">行間</div>
    <div class="seg">
      <button v-for="l in LINE_HEIGHTS" :key="l" :class="{ active: display.lineHeight === l }" @click="set({ lineHeight: l })">{{ l }}</button>
    </div>
    <div class="preview" :style="previewStyle">吾輩は猫である。名前はまだ無い。<ruby>何処<rt>どこ</rt></ruby>で生れたかとんと見当がつかぬ。</div>
    <p class="muted">各サイトの話ページの本文にのみ適用されます。</p>
  </BottomSheet>
</template>

<style scoped>
.seg-note { font-size: 11px; font-weight: 400; }
</style>
