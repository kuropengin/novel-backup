<script setup lang="ts">
import Icon from "./Icon.vue";
import { initialOf } from "../logic/lists";
import { theme } from "../stores/theme";

/** reader: リーダー表示中(左に戻る、右端にリーダーメニューのボタンを出す) */
defineProps<{ username: string; hidden: boolean; reader?: boolean }>();
const emit = defineEmits<{ (e: "menu"): void; (e: "display"): void; (e: "theme"): void; (e: "brand"): void; (e: "back"): void; (e: "reader-menu"): void }>();
</script>

<template>
  <header class="topbar" :class="{ hidden }">
    <div class="side">
      <button v-if="reader" class="icon-btn" aria-label="戻る" @click="emit('back')"><Icon name="back" /></button>
      <button class="avatar" aria-label="メニュー" @click="emit('menu')">{{ initialOf(username) }}</button>
    </div>
    <button class="app-mark" aria-label="小説ビューア" @click="emit('brand')"><Icon name="book" :size="18" /></button>
    <div class="side right">
      <button class="icon-btn" aria-label="本文の表示設定" @click="emit('display')"><span class="aa">Aa</span></button>
      <button class="icon-btn" :aria-label="theme === 'dark' ? 'ライトテーマ' : 'ダークテーマ'" @click="emit('theme')">
        <Icon :name="theme === 'dark' ? 'sun' : 'moon'" :size="22" />
      </button>
      <button v-if="reader" class="icon-btn" aria-label="リーダーメニュー" @click="emit('reader-menu')"><Icon name="menu" :size="22" /></button>
    </div>
  </header>
</template>
