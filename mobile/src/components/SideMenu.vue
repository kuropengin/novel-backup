<script setup lang="ts">
import { onUnmounted, watch } from "vue";
import Icon from "./Icon.vue";
import { initialOf } from "../logic/lists";
import { pushOverlay } from "../stores/overlays";

const props = defineProps<{ open: boolean; username: string; role: string; isAdmin: boolean }>();
const emit = defineEmits<{ (e: "close"): void; (e: "settings"): void; (e: "users"): void; (e: "logout"): void }>();

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
  <Transition name="slide-left">
    <aside v-if="open" class="side-menu">
      <div class="who">
        <div class="avatar">{{ initialOf(username) }}</div>
        <div class="name">{{ username }}</div>
        <div class="muted">{{ role === "admin" ? "管理者" : "閲覧者" }}</div>
      </div>
      <div class="menu-sep" />
      <button class="menu-item" @click="emit('settings')"><Icon name="sliders" />設定</button>
      <button v-if="isAdmin" class="menu-item" @click="emit('users')"><Icon name="users" />ユーザー管理</button>
      <div class="menu-sep" />
      <button class="menu-item danger" @click="emit('logout')"><Icon name="logout" />ログアウト</button>
    </aside>
  </Transition>
</template>
