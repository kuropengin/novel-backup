import { api } from "./client";
import type {
  BackupEpisodeResponse,
  BackupNovel,
  BackupNovelDetail,
  BackupRun,
  BackupStatus,
} from "./types";

export const backupsApi = {
  novels: () => api<{ novels: BackupNovel[] }>("/api/backups/novels"),
  novel: (id: number) => api<BackupNovelDetail>(`/api/backups/novels/${id}`),
  episode: (novelId: number, episodeId: number, version?: number) =>
    api<BackupEpisodeResponse>(
      `/api/backups/novels/${novelId}/episodes/${episodeId}${version ? `/versions/${version}` : ""}`,
    ),
  runNovel: (id: number, force = false) =>
    api<{ queued: boolean; alreadyQueued: boolean }>(`/api/backups/novels/${id}/run`, { method: "POST", body: { force } }),
  removeNovel: (id: number) => api<{ ok: true }>(`/api/backups/novels/${id}`, { method: "DELETE" }),
  exportUrl: (id: number, format: "txt" | "html") => `/api/backups/novels/${id}/export?format=${format}`,
  status: () => api<BackupStatus>("/api/backups/status"),
  runs: () => api<{ runs: BackupRun[] }>("/api/backups/runs"),
  runAll: (force = false) => api<{ started: true; runId: number }>("/api/backups/run", { method: "POST", body: { force } }),
};
