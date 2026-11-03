<script setup lang="ts">
import { onMounted, ref } from "vue";
import Icon from "../components/Icon.vue";
import { ApiError, errorMessage } from "../api";
import type { Settings } from "../storage";
import { dismiss, markAllRead, markRead, notifications, syncNotifications, unread } from "../stores/notifications";
import { confirmNative } from "../native/dialogs";
import { relativeTime } from "../logic/lists";

const props = defineProps<{ settings: Settings }>();
const emit = defineEmits<{ (e: "unauthorized"): void }>();
const error = ref("");

const cfg = () => ({ serverUrl: props.settings.serverUrl, token: props.settings.token });

onMounted(async () => {
  try {
    await syncNotifications(cfg());
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) emit("unauthorized");
    else error.value = errorMessage(e);
  }
});

async function clearAll() {
  if (!(await confirmNative("お知らせをすべて削除しますか?", "削除", "削除"))) return;
  const ids = notifications.value.map((n) => n.id);
  for (const id of ids) {
    await dismiss(id, cfg());
  }
}

async function readOne(id: string) {
  try {
    await markRead(id, cfg());
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) emit("unauthorized");
    else error.value = errorMessage(e);
  }
}

async function readAll() {
  try {
    await markAllRead(cfg());
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) emit("unauthorized");
    else error.value = errorMessage(e);
  }
}
</script>

<template>
  <div>
    <div class="toolbar" style="padding-top: 8px">
      <h1>お知らせ</h1>
      <div class="row">
        <button class="btn secondary small" :disabled="unread === 0" @click="readAll">すべて既読</button>
        <button class="btn secondary small" :disabled="notifications.length === 0" @click="clearAll">削除</button>
      </div>
    </div>
    <p v-if="error" class="error page">{{ error }}</p>
    <div v-if="notifications.length === 0" class="empty">
      <div class="big">お知らせはありません</div>
      オフライン保存やバックアップの完了などを、ここでお知らせします。
    </div>
    <button v-for="n in notifications" :key="n.id" class="list-row row-btn" @click="readOne(n.id)">
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
