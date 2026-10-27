<script setup lang="ts">
import { onMounted, ref } from "vue";
import { usersApi } from "../api";
import { errorMessage } from "../api/client";
import type { Role, UserDetail } from "../api/types";
import { useAuthStore } from "../stores/auth";

const auth = useAuthStore();
const users = ref<UserDetail[]>([]);
const error = ref("");
const username = ref("");
const password = ref("");
const role = ref<Role>("viewer");

async function load() {
  try {
    users.value = (await usersApi.list()).users;
  } catch (e) {
    error.value = errorMessage(e);
  }
}

async function run(fn: () => Promise<unknown>) {
  error.value = "";
  try {
    await fn();
    await load();
  } catch (e) {
    error.value = errorMessage(e);
  }
}

const create = () =>
  run(async () => {
    await usersApi.create(username.value, password.value, role.value);
    username.value = password.value = "";
    role.value = "viewer";
  });

const changeRole = (u: UserDetail, r: Role) => run(() => usersApi.update(u.id, { role: r }));

function resetPassword(u: UserDetail) {
  const p = window.prompt(`${u.username} の新しいパスワード(8文字以上)`);
  if (p) void run(() => usersApi.update(u.id, { password: p }));
}

function remove(u: UserDetail) {
  if (window.confirm(`ユーザー ${u.username} を削除しますか?`)) void run(() => usersApi.remove(u.id));
}

onMounted(load);
</script>

<template>
  <h2>ユーザー管理</h2>
  <p v-if="error" class="error">{{ error }}</p>

  <div class="card table-wrap">
    <table class="table">
      <thead>
        <tr><th>ユーザー名</th><th>ロール</th><th>作成日時</th><th></th></tr>
      </thead>
      <tbody>
        <tr v-for="u in users" :key="u.id">
          <td>{{ u.username }}<span v-if="u.id === auth.user?.id" class="muted">(自分)</span></td>
          <td>
            <select :value="u.role" @change="changeRole(u, ($event.target as HTMLSelectElement).value as Role)">
              <option value="admin">管理者</option>
              <option value="viewer">閲覧者</option>
            </select>
          </td>
          <td>{{ new Date(u.createdAt).toLocaleString() }}</td>
          <td>
            <div class="row-actions">
              <button class="secondary small" @click="resetPassword(u)">パスワード再設定</button>
              <button class="danger small" :disabled="u.id === auth.user?.id" @click="remove(u)">削除</button>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
  </div>

  <div class="card">
    <h3 style="margin-top: 0">ユーザー追加</h3>
    <form class="inline-form" @submit.prevent="create">
      <label>ユーザー名<input v-model="username" autocomplete="off" required /></label>
      <label>パスワード<input v-model="password" type="password" autocomplete="new-password" required /></label>
      <label>
        ロール
        <select v-model="role">
          <option value="viewer">閲覧者</option>
          <option value="admin">管理者</option>
        </select>
      </label>
      <button>追加</button>
    </form>
  </div>
</template>
