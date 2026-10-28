<script setup lang="ts">
import { onMounted, ref } from "vue";
import { ApiError, createUser, deleteUser, errorMessage, listUsers, updateUser, type Role, type User } from "../api";
import type { Settings } from "../storage";
import { confirmNative } from "../native/dialogs";

const props = defineProps<{ settings: Settings }>();
const emit = defineEmits<{ (e: "unauthorized"): void }>();

const ROLE_LABELS: Record<Role, string> = { admin: "管理者", viewer: "閲覧者" };

const users = ref<User[]>([]);
const loading = ref(false);
const busy = ref(false);
const error = ref("");

const cfg = () => ({ serverUrl: props.settings.serverUrl, token: props.settings.token });

/** 操作を実行。401 は再ログインへ、それ以外のエラーは画面に表示する。 */
async function run(fn: () => Promise<void>): Promise<boolean> {
  error.value = "";
  busy.value = true;
  try {
    await fn();
    return true;
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) emit("unauthorized");
    else error.value = errorMessage(e);
    return false;
  } finally {
    busy.value = false;
  }
}

async function load() {
  loading.value = true;
  await run(async () => {
    users.value = await listUsers(cfg());
  });
  loading.value = false;
}
onMounted(load);

// 作成
const newName = ref("");
const newPass = ref("");
const newRole = ref<Role>("viewer");
async function add() {
  if (!newName.value || !newPass.value) {
    error.value = "ユーザー名とパスワードを入力してください";
    return;
  }
  const ok = await run(async () => {
    await createUser(cfg(), { username: newName.value, password: newPass.value, role: newRole.value });
    users.value = await listUsers(cfg());
  });
  if (ok) {
    newName.value = "";
    newPass.value = "";
    newRole.value = "viewer";
  }
}

// ロール変更
async function setRole(u: User, role: Role) {
  if (role === u.role) return;
  const ok = await run(async () => {
    const next = await updateUser(cfg(), u.id, { role });
    users.value = users.value.map((x) => (x.id === u.id ? next : x));
  });
  if (!ok) await load(); // 失敗時(最後の管理者など)は表示を実際の値へ戻す
}

// パスワード再設定
const resetId = ref<number | null>(null);
const resetPass = ref("");
async function resetPassword(u: User) {
  if (!resetPass.value) {
    error.value = "新しいパスワードを入力してください";
    return;
  }
  const ok = await run(async () => {
    await updateUser(cfg(), u.id, { password: resetPass.value });
  });
  if (ok) {
    resetId.value = null;
    resetPass.value = "";
  }
}

// 削除
async function remove(u: User) {
  if (!(await confirmNative(`ユーザー「${u.username}」を削除しますか?(お気に入り・閲覧履歴も削除されます)`, "ユーザーの削除", "削除"))) return;
  await run(async () => {
    await deleteUser(cfg(), u.id);
    users.value = users.value.filter((x) => x.id !== u.id);
  });
}
</script>

<template>
  <div class="page">
  <div class="row between" style="margin-top: 12px">
    <h2 style="margin: 0">ユーザー</h2>
    <button class="btn secondary small" :disabled="loading || busy" @click="load">更新</button>
  </div>
  <p v-if="error" class="error">{{ error }}</p>

  <div v-for="u in users" :key="u.id" class="card">
    <strong>{{ u.username }}</strong>
    <span v-if="u.username === settings.username" class="muted">(自分)</span>
    <div class="muted">{{ ROLE_LABELS[u.role] }}</div>
    <template v-if="u.username !== settings.username">
      <div class="row" style="margin-top: 8px">
        <select :value="u.role" :disabled="busy" @change="setRole(u, ($event.target as HTMLSelectElement).value as Role)">
          <option value="admin">管理者</option>
          <option value="viewer">閲覧者</option>
        </select>
        <button class="small secondary" :disabled="busy" @click="resetId = resetId === u.id ? null : u.id; resetPass = ''">パスワード再設定</button>
        <button class="small danger" :disabled="busy" @click="remove(u)">削除</button>
      </div>
      <div v-if="resetId === u.id" style="margin-top: 8px">
        <label :for="`rp${u.id}`">新しいパスワード(8 文字以上)</label>
        <input :id="`rp${u.id}`" v-model="resetPass" type="password" autocomplete="new-password" @keyup.enter="resetPassword(u)" />
        <div class="row" style="margin-top: 8px">
          <button class="small" :disabled="busy" @click="resetPassword(u)">設定</button>
        </div>
      </div>
    </template>
    <p v-else class="muted">自分のパスワードは「設定」から変更できます。</p>
  </div>

  <h2>ユーザーを追加</h2>
  <div class="card">
    <label for="nu">ユーザー名(英数字・_・- の 3〜32 文字)</label>
    <input id="nu" v-model="newName" autocapitalize="off" autocomplete="off" />
    <label for="np">パスワード(8 文字以上)</label>
    <input id="np" v-model="newPass" type="password" autocomplete="new-password" />
    <label for="nr">ロール</label>
    <select id="nr" v-model="newRole">
      <option value="viewer">閲覧者</option>
      <option value="admin">管理者</option>
    </select>
    <div class="row" style="margin-top: 12px">
      <button :disabled="busy" @click="add">追加</button>
    </div>
  </div>
  </div>
</template>
