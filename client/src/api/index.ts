import { api } from "./client";
import type { AuthStatus, Role, Settings, User, UserDetail } from "./types";

export const authApi = {
  status: () => api<AuthStatus>("/api/auth/status", { noRedirect: true }),
  setup: (username: string, password: string) =>
    api<{ user: User }>("/api/auth/setup", { method: "POST", body: { username, password }, noRedirect: true }),
  login: (username: string, password: string) =>
    api<{ user: User }>("/api/auth/login", { method: "POST", body: { username, password }, noRedirect: true }),
  logout: () => api<{ ok: true }>("/api/auth/logout", { method: "POST", noRedirect: true }),
  changePassword: (currentPassword: string, newPassword: string) =>
    api<{ ok: true }>("/api/auth/password", { method: "POST", body: { currentPassword, newPassword } }),
};

export const usersApi = {
  list: () => api<{ users: UserDetail[] }>("/api/users"),
  create: (username: string, password: string, role: Role) =>
    api<{ user: UserDetail }>("/api/users", { method: "POST", body: { username, password, role } }),
  update: (id: number, patch: { role?: Role; password?: string }) =>
    api<{ user: UserDetail }>(`/api/users/${id}`, { method: "PATCH", body: patch }),
  remove: (id: number) => api<{ ok: true }>(`/api/users/${id}`, { method: "DELETE" }),
};

export const settingsApi = {
  get: () => api<Settings>("/api/settings"),
  update: (patch: Partial<Settings> & { hamelnCookie?: string }) => api<Settings>("/api/settings", { method: "PUT", body: patch }),
};
export { liveApi, bookmarksApi } from "./live";
export { backupsApi } from "./backups";
