<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { backupsApi, settingsApi } from "../api";
import { errorMessage } from "../api/client";
import type { BackupStatus, Settings } from "../api/types";
import { fmtDateTime } from "../composables/format";

const form = ref<Settings>({
  backupIntervalMinutes: 360,
  backupStartAt: null,
  requestIntervalMs: 1500,
  fullRecheckEveryRuns: 0,
  maxEpisodesPerNovelPerRun: 0,
  hamelnUserAgent: "",
  hamelnCookieSet: false,
  hamelnCookieNames: [],
});
const cookieInput = ref("");
const hamelnMsg = ref("");

function fillUa() {
  form.value.hamelnUserAgent = navigator.userAgent;
}

async function saveHameln(clear = false) {
  error.value = hamelnMsg.value = "";
  if (clear && !confirm("保存済みの Cookie を削除します。よろしいですか?")) return;
  busy.value = true;
  try {
    const patch: { hamelnUserAgent: string; hamelnCookie?: string } = {
      hamelnUserAgent: clear ? "" : form.value.hamelnUserAgent,
    };
    if (clear) patch.hamelnCookie = "";
    else if (cookieInput.value.trim()) patch.hamelnCookie = cookieInput.value;
    const s = await settingsApi.update(patch);
    form.value = { ...form.value, ...s };
    cookieInput.value = "";
    hamelnMsg.value = clear ? "クリアしました。" : "保存しました。";
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}
const useStart = ref(false);
const status = ref<BackupStatus | null>(null);
const error = ref("");
const ok = ref("");
const force = ref(false);
const busy = ref(false);
let timer: ReturnType<typeof setInterval> | null = null;

async function loadStatus() {
  try {
    status.value = await backupsApi.status();
  } catch {
    /* ignore */
  }
}

onMounted(async () => {
  try {
    const s = await settingsApi.get();
    form.value = { ...s };
    useStart.value = s.backupStartAt !== null;
  } catch (e) {
    error.value = errorMessage(e);
  }
  await loadStatus();
  timer = setInterval(loadStatus, 5000);
});
onBeforeUnmount(() => timer && clearInterval(timer));

async function save() {
  error.value = ok.value = "";
  busy.value = true;
  try {
    const f = form.value;
    const s = await settingsApi.update({
      backupIntervalMinutes: f.backupIntervalMinutes,
      backupStartAt: useStart.value ? (f.backupStartAt ?? "03:00") : null,
      requestIntervalMs: f.requestIntervalMs,
      fullRecheckEveryRuns: f.fullRecheckEveryRuns,
      maxEpisodesPerNovelPerRun: f.maxEpisodesPerNovelPerRun,
    });
    form.value = { ...s };
    useStart.value = s.backupStartAt !== null;
    ok.value = "保存しました。";
    await loadStatus();
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}

async function runAll() {
  error.value = ok.value = "";
  if (force.value && !confirm("全作品の全話本文を再取得します。サイトへの負荷が大きくなります。実行しますか?")) return;
  busy.value = true;
  try {
    await backupsApi.runAll(force.value);
    ok.value = "全作品のバックアップを開始しました。";
    await loadStatus();
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <h2>バックアップ設定</h2>

  <div class="card">
    <h3 style="margin-top: 0">現在の状態</h3>
    <template v-if="status">
      <p>
        <span class="badge" :class="{ admin: status.running }">{{ status.running ? "実行中" : "待機中" }}</span>
        <span v-if="status.runningAll" class="muted"> 全作品の一括実行中</span>
        <span v-if="status.currentNovel" class="muted"> / 処理中: {{ status.currentNovel.title || `#${status.currentNovel.id}` }}</span>
      </p>
      <p class="muted">実行待ち: {{ status.queueLength }} 件 / 次回の定期実行: {{ status.nextRunAt ? fmtDateTime(status.nextRunAt) : "予定なし(無効または実行中)" }}</p>
    </template>
    <p v-else class="muted">取得中…</p>
    <div class="row-actions">
      <button :disabled="busy || status?.runningAll" @click="runAll">全作品を今すぐバックアップ</button>
      <label class="check"><input v-model="force" type="checkbox" /> 全話を再取得して比較する(force)</label>
    </div>
  </div>

  <form class="card form" @submit.prevent="save">
    <label>
      定期実行の間隔(分。0 で無効、有効時は 30 以上)
      <input v-model.number="form.backupIntervalMinutes" type="number" min="0" step="1" required />
    </label>
    <label class="check"><input v-model="useStart" type="checkbox" /> 基準時刻を指定する(例: 03:00 + 360 分 → 3・9・15・21 時)</label>
    <label v-if="useStart">
      基準時刻(サーバーのローカル時刻)
      <input v-model="form.backupStartAt" type="time" required />
    </label>
    <label>
      同一ホストへの最小リクエスト間隔(ミリ秒、1000 以上)
      <input v-model.number="form.requestIntervalMs" type="number" min="1000" step="100" required />
    </label>
    <label>
      N 回に 1 回、全話本文を再取得して比較(0 で無効。カクヨムは更新日時が無いため、これが改稿検知の唯一の手段)
      <input v-model.number="form.fullRecheckEveryRuns" type="number" min="0" step="1" required />
    </label>
    <label>
      1 回の実行で 1 作品あたり取得する本文数の上限(0 で無制限。大長編の初回取得の分割用)
      <input v-model.number="form.maxEpisodesPerNovelPerRun" type="number" min="0" step="1" required />
    </label>
    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="ok" class="ok">{{ ok }}</p>
    <div><button type="submit" :disabled="busy">保存</button></div>
  </form>

  <form class="card form" @submit.prevent="saveHameln(false)">
    <h3 style="margin-top: 0">ハーメルン接続</h3>
    <p class="muted">
      ハーメルンは Cloudflare のボット判定によりサーバーからの取得がブロックされることがあります。
      自分のブラウザの Cookie と User-Agent をここに設定すると、サーバーからハーメルン(syosetu.org)へのリクエストにのみ付与されます。
      Cookie は秘密情報として保存され、画面・API には再表示されません。
    </p>
    <p>
      状態:
      <span class="badge" :class="{ admin: form.hamelnCookieSet }">{{ form.hamelnCookieSet ? "Cookie 設定済み" : "未設定" }}</span>
      <span v-if="form.hamelnCookieSet" class="muted"> Cookie 名: {{ form.hamelnCookieNames.join(", ") }}</span>
    </p>
    <label>
      Cookie(空欄のまま保存すると現在の値を維持)
      <textarea
        v-model="cookieInput"
        rows="4"
        maxlength="8192"
        autocomplete="off"
        spellcheck="false"
        placeholder="同じブラウザで syosetu.org を開き、開発者ツール(F12)→ Network → 任意のリクエスト → リクエストヘッダの cookie の値をコピーして貼り付け。cf_clearance があれば含めてください。"
      ></textarea>
    </label>
    <label>
      User-Agent(空ならサーバー既定)
      <input v-model="form.hamelnUserAgent" type="text" maxlength="500" />
    </label>
    <div class="row-actions">
      <button type="button" @click="fillUa">このブラウザのUAを入力</button>
    </div>
    <p class="muted">
      Cloudflare の通過 Cookie(cf_clearance)は、取得したブラウザの IP アドレスと User-Agent に紐付き、期限切れになります。
      このサーバーはそのブラウザと同じネットワーク(同じ IP)で動かし、ハーメルンで「ブロックされた」旨が表示されたら値を取り直して更新してください。
      サイトの利用規約の遵守は利用者の責任で行ってください。
    </p>
    <p v-if="hamelnMsg" class="ok">{{ hamelnMsg }}</p>
    <div class="row-actions">
      <button type="submit" :disabled="busy">保存</button>
      <button type="button" :disabled="busy || !form.hamelnCookieSet" @click="saveHameln(true)">クリア</button>
    </div>
  </form>
</template>

<style scoped>
.form { max-width: 560px; }
.check { flex-direction: row !important; align-items: center; gap: 6px; }
</style>
