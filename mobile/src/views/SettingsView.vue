<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { isInsecureRemote } from "../logic/serverUrl";
import { ApiError, changePassword, errorMessage, getBackupSettings, updateBackupSettings, type BackupScheduleSettings } from "../api";
import type { Settings } from "../storage";
import { confirmNative } from "../native/dialogs";
import { statusView } from "../logic/adblock";
import { blocklistLoading, blocklists, blocklistStatus, createBlocklist, refreshBlocklistStatus, removeBlocklist, startAdblock, toggleBlocklist } from "../stores/adblock";

/** 設定(ログイン後): アカウントとサーバー、パスワード変更。本文の表示設定は上バーの「Aa」から。 */
const props = defineProps<{ settings: Settings }>();
const emit = defineEmits<{ (e: "logout"): void; (e: "unauthorized"): void }>();

const curPw = ref("");
const newPw = ref("");
const newPw2 = ref("");
const msg = ref("");
const error = ref("");
const busy = ref(false);
const backupBusy = ref(false);
const backupError = ref("");
const backupMsg = ref("");
const backupSettings = ref<BackupScheduleSettings>({ frequency: "hourly", time: "03:00", maxParallel: 5 });
const isAdmin = computed(() => props.settings.role === "admin");

// 広告ブロック
const abBusy = ref(false);
const abError = ref("");
const abName = ref("");
const abUrl = ref("");
const abCfg = () => ({ serverUrl: props.settings.serverUrl, token: props.settings.token });
const abRows = computed(() => blocklists.value.map((l) => ({ list: l, st: statusView(l.enabled, blocklistStatus.value[l.url]) })));
let abTimer: ReturnType<typeof setInterval> | undefined;

/** 処理中は数秒ごとに状況を取り直し、終わったら止める */
function watchStatus() {
  if (abTimer) clearInterval(abTimer);
  void refreshBlocklistStatus();
  abTimer = setInterval(async () => {
    await refreshBlocklistStatus();
    if (!blocklistLoading.value && abTimer) {
      clearInterval(abTimer);
      abTimer = undefined;
    }
  }, 2000);
}
onUnmounted(() => abTimer && clearInterval(abTimer));

function abMessage(e: unknown): string {
  if (e instanceof ApiError && e.code === "validation_error") return "名前は 1〜64 文字、URL は https のもの(IP アドレス・localhost・.local は不可)を入力してください";
  return errorMessage(e);
}
async function abRun(fn: () => Promise<void>) {
  abError.value = "";
  abBusy.value = true;
  try {
    await fn();
    watchStatus();
  } catch (e) {
    if (e instanceof ApiError && e.status === 401 && e.code === "unauthorized") emit("unauthorized");
    else abError.value = abMessage(e);
  } finally {
    abBusy.value = false;
  }
}
const abToggle = (id: number, enabled: boolean) => abRun(() => toggleBlocklist(abCfg(), props.settings.username, id, enabled));
async function abAdd() {
  const name = abName.value.trim();
  const url = abUrl.value.trim();
  if (!name || !url) {
    abError.value = "名前と URL を入力してください";
    return;
  }
  await abRun(async () => {
    await createBlocklist(abCfg(), props.settings.username, name, url);
    abName.value = abUrl.value = "";
  });
}
async function abRemove(id: number, name: string) {
  if (!(await confirmNative(`「${name}」を削除しますか?`, "リストの削除", "削除"))) return;
  await abRun(() => removeBlocklist(abCfg(), props.settings.username, id));
}

onMounted(async () => {
  if (blocklists.value.length === 0) {
    // 未取得(起動直後にネットワーク不達だった等)なら取り直す
    void abRun(() => startAdblock(abCfg(), props.settings.username));
  } else watchStatus();
  if (!isAdmin.value) return;
  try {
    backupSettings.value = await getBackupSettings({ serverUrl: props.settings.serverUrl, token: props.settings.token });
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) emit("unauthorized");
    else backupError.value = errorMessage(e);
  }
});

async function doChangePassword() {
  msg.value = "";
  error.value = "";
  if (!curPw.value || !newPw.value) {
    error.value = "現在のパスワードと新しいパスワードを入力してください";
    return;
  }
  if (newPw.value !== newPw2.value) {
    error.value = "新しいパスワード(確認)が一致しません";
    return;
  }
  busy.value = true;
  try {
    await changePassword({ serverUrl: props.settings.serverUrl, token: props.settings.token }, curPw.value, newPw.value);
    curPw.value = newPw.value = newPw2.value = "";
    msg.value = "パスワードを変更しました(他の端末はログアウトされます)";
  } catch (e) {
    if (e instanceof ApiError && e.status === 401 && e.code === "unauthorized") emit("unauthorized");
    else error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}

async function saveBackupSchedule() {
  backupError.value = "";
  backupMsg.value = "";
  backupBusy.value = true;
  try {
    backupSettings.value = await updateBackupSettings(
      { serverUrl: props.settings.serverUrl, token: props.settings.token },
      backupSettings.value
    );
    backupMsg.value = "バックアップ定期設定を更新しました";
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) emit("unauthorized");
    else backupError.value = errorMessage(e);
  } finally {
    backupBusy.value = false;
  }
}
</script>

<template>
  <div class="page">
    <h2>アカウント</h2>
    <div class="card">
      <div><strong>{{ settings.username }}</strong> <span class="muted">({{ settings.role === "admin" ? "管理者" : "閲覧者" }})</span></div>
      <label>サーバー URL</label>
      <div style="word-break: break-all">{{ settings.serverUrl }}</div>
      <p v-if="isInsecureRemote(settings.serverUrl)" class="error">⚠ 暗号化されていない接続(http)です。https のサーバーへの切り替えを推奨します。</p>
      <p class="muted">サーバーを変更するには、ログアウトして接続し直してください。</p>
      <button class="danger" @click="emit('logout')">ログアウトしてサーバーを変更</button>
    </div>

    <template v-if="isAdmin">
      <h2>バックアップ定期設定</h2>
      <div class="card">
        <label for="freq" style="margin-top: 0">実行間隔</label>
        <select id="freq" v-model="backupSettings.frequency">
          <option value="hourly">毎時間</option>
          <option value="daily">毎日</option>
          <option value="weekly">毎週</option>
        </select>

        <label for="time">実行時刻(HH:mm)</label>
        <input id="time" v-model="backupSettings.time" type="time" />

        <label for="parallel">同時実行数(1〜10)</label>
        <input id="parallel" v-model.number="backupSettings.maxParallel" type="number" min="1" max="10" />

        <p v-if="backupError" class="error">{{ backupError }}</p>
        <p v-if="backupMsg" class="ok">{{ backupMsg }}</p>
        <div class="row" style="margin-top: 12px">
          <button :disabled="backupBusy" @click="saveBackupSchedule">バックアップ設定を保存</button>
        </div>
      </div>
    </template>

    <h2>広告ブロック</h2>
    <div class="card">
      <p class="muted" style="margin-top: 0">
        アプリ内のサイトビューアで、ブロックリストに載っているドメインへの通信(広告・トラッキング)だけを遮断します。端末の DNS は変更せず、他のアプリやブラウザには影響しません。
        サイトによっては正しく表示されないことがあります。その場合は該当するリストをオフにしてください。
      </p>
      <div v-for="r in abRows" :key="r.list.id" class="ab-item">
        <div class="ab-head">
          <div class="ab-name">
            <strong>{{ r.list.name }}</strong>
            <span v-if="r.list.presetKey" class="ab-badge">プリインストール</span>
          </div>
          <label class="ab-switch" :aria-label="`${r.list.name} のオン/オフ`">
            <input type="checkbox" :checked="r.list.enabled" :disabled="abBusy" @change="abToggle(r.list.id, ($event.target as HTMLInputElement).checked)" />
            <span class="ab-track"></span>
          </label>
        </div>
        <div class="muted ab-meta">
          <template v-if="r.st.kind === 'off'">オフ</template>
          <template v-else-if="r.st.kind === 'pending'">{{ blocklistLoading ? "取得中…" : "未取得" }}</template>
          <template v-else-if="r.st.kind === 'error'"><span class="error">取得に失敗しました</span></template>
          <template v-else>件数 {{ r.st.domains?.toLocaleString() }}</template>
          <template v-if="r.st.updated"> ・ 最終更新 {{ r.st.updated }}</template>
        </div>
        <p v-if="r.st.kind === 'cached-error'" class="error ab-meta">更新に失敗したため、保存済みのリストを使っています</p>
        <div v-if="!r.list.presetKey" class="ab-url muted">{{ r.list.url }}</div>
        <div v-if="!r.list.presetKey" class="row" style="margin-top: 6px">
          <button class="danger small" :disabled="abBusy" @click="abRemove(r.list.id, r.list.name)">削除</button>
        </div>
      </div>
      <div class="row" style="margin-top: 8px">
        <button class="secondary small" :disabled="abBusy" @click="watchStatus">状況を更新</button>
        <span v-if="blocklistLoading" class="muted">取得・解析中…</span>
      </div>

      <label for="abn">リストを追加(名前)</label>
      <input id="abn" v-model="abName" type="text" maxlength="64" placeholder="例: 自分用リスト" />
      <label for="abu">URL(https のみ)</label>
      <input id="abu" v-model="abUrl" type="url" inputmode="url" autocapitalize="off" placeholder="https://example.com/list.txt" @keyup.enter="abAdd" />
      <p v-if="abError" class="error">{{ abError }}</p>
      <div class="row" style="margin-top: 12px">
        <button :disabled="abBusy" @click="abAdd">追加</button>
      </div>
    </div>

    <h2>パスワード変更</h2>
    <div class="card">
      <label for="cp" style="margin-top: 0">現在のパスワード</label>
      <input id="cp" v-model="curPw" type="password" autocomplete="current-password" />
      <label for="np">新しいパスワード(8 文字以上)</label>
      <input id="np" v-model="newPw" type="password" autocomplete="new-password" />
      <label for="np2">新しいパスワード(確認)</label>
      <input id="np2" v-model="newPw2" type="password" autocomplete="new-password" @keyup.enter="doChangePassword" />
      <p v-if="error" class="error">{{ error }}</p>
      <p v-if="msg" class="ok">{{ msg }}</p>
      <div class="row" style="margin-top: 12px">
        <button :disabled="busy" @click="doChangePassword">変更</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ab-item { padding: 10px 0; border-bottom: 1px solid var(--border); }
.ab-item:first-of-type { padding-top: 0; }
.ab-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.ab-name { min-width: 0; word-break: break-word; }
.ab-badge { margin-left: 8px; font-size: 11px; padding: 1px 8px; border: 1px solid var(--border); border-radius: 999px; color: var(--muted); white-space: nowrap; }
.ab-meta { margin: 4px 0 0; }
.ab-url { word-break: break-all; font-size: 12px; margin-top: 2px; }
.ab-switch { position: relative; display: inline-block; flex: none; width: 46px; height: 26px; margin: 0; }
.ab-switch input { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; padding: 0; border: 0; opacity: 0; z-index: 1; }
.ab-track { position: absolute; inset: 0; border-radius: 999px; background: color-mix(in srgb, var(--muted) 40%, transparent); transition: background 0.15s; }
.ab-track::after { content: ""; position: absolute; top: 3px; left: 3px; width: 20px; height: 20px; border-radius: 50%; background: var(--bg); box-shadow: 0 0 0 1px var(--muted); transition: transform 0.15s; }
.ab-switch input:checked + .ab-track { background: var(--accent); }
.ab-switch input:checked + .ab-track::after { transform: translateX(20px); box-shadow: none; }
.ab-switch input:disabled + .ab-track { opacity: 0.5; }
</style>
