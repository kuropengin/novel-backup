<script setup lang="ts">
import Icon from "./Icon.vue";

import type { Tab } from "../types";

defineProps<{ tab: Tab; hidden: boolean; starEnabled: boolean; bookmarked: boolean; unread: number }>();
const emit = defineEmits<{ (e: "tab", t: Tab): void; (e: "star"): void }>();
</script>

<template>
  <nav class="bottombar" :class="{ hidden }">
    <button class="tab" :class="{ active: tab === 'home' }" @click="emit('tab', 'home')">
      <Icon name="home" :fill="tab === 'home'" /><span>ホーム</span>
    </button>
    <button class="tab" :class="{ active: tab === 'bookmarks' }" @click="emit('tab', 'bookmarks')">
      <Icon name="star" :fill="tab === 'bookmarks'" /><span>お気に入り</span>
    </button>
    <button
      class="star-btn"
      :class="{ enabled: starEnabled && !bookmarked, on: starEnabled && bookmarked }"
      :disabled="!starEnabled"
      :aria-label="bookmarked ? 'お気に入りを解除' : 'お気に入りに追加'"
      @click="emit('star')"
    >
      <Icon name="star" :size="28" :fill="starEnabled && bookmarked" />
    </button>
    <button class="tab" :class="{ active: tab === 'history' }" @click="emit('tab', 'history')">
      <Icon name="clock" /><span>閲覧履歴</span>
    </button>
    <button class="tab" :class="{ active: tab === 'notifications' }" @click="emit('tab', 'notifications')">
      <Icon name="bell" :fill="tab === 'notifications'" /><span>お知らせ</span>
      <span v-if="unread > 0" class="badge">{{ unread > 99 ? "99+" : unread }}</span>
    </button>
  </nav>
</template>
