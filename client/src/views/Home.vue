<script setup>
import { ref } from "vue";

const health = ref(null);
fetch("/api/health")
  .then((r) => r.json())
  .then((d) => (health.value = d))
  .catch(() => (health.value = null));
</script>

<template>
  <h2>ホーム</h2>
  <p v-if="health">サーバー稼働中 (v{{ health.version }})</p>
  <p v-else>サーバーに応答がありません。`npm start`(本番)または `npm run dev`(開発)を起動してください。</p>
</template>
