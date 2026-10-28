<script setup lang="ts">
import Icon from "../components/Icon.vue";
import { clearNotifications, markAllRead, markRead, notifications, unread } from "../stores/notifications";
import { confirmNative } from "../native/dialogs";
import { relativeTime } from "../logic/lists";

async function clearAll() {
  if (await confirmNative("お知らせをすべて削除しますか?", "削除", "削除")) clearNotifications();
}
</script>

<template>
  <div>
    <div class="toolbar" style="padding-top: 8px">
      <h1>お知らせ</h1>
      <div class="row">
        <button class="btn secondary small" :disabled="unread === 0" @click="markAllRead">すべて既読</button>
        <button class="btn secondary small" :disabled="notifications.length === 0" @click="clearAll">削除</button>
      </div>
    </div>
    <div v-if="notifications.length === 0" class="empty">
      <div class="big">お知らせはありません</div>
      オフライン保存やバックアップの完了などを、ここでお知らせします。
    </div>
    <button v-for="n in notifications" :key="n.id" class="list-row row-btn" @click="markRead(n.id)">
      <span class="dot-col"><span v-if="!n.read" class="dot" /></span>
      <Icon name="bell" :size="20" />
      <div class="main">
        <div class="title" :style="{ fontWeight: n.read ? 500 : 800 }">{{ n.title }}</div>
        <div v-if="n.body" class="sub wrap">{{ n.body }}</div>
        <div class="meta">{{ relativeTime(n.createdAt) }}</div>
      </div>
    </button>
  </div>
</template>
