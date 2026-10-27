export type BackupTrigger = "schedule" | "manual" | "bookmark" | "novel";

/** 作品単位の投入先(scheduler)。起動時に index.ts が登録する。未登録(テスト等)ならログのみ。 */
export interface BackupQueue {
  enqueue(novelId: number, trigger: BackupTrigger): unknown;
}

let queue: BackupQueue | null = null;

export function setBackupQueue(q: BackupQueue | null): void {
  queue = q;
}

/** 作品単位のバックアップ投入口(ブックマーク追加時など)。 */
export function enqueueNovelBackup(novelId: number, trigger: BackupTrigger): void {
  if (!queue) {
    console.log(`[backup] enqueue (no queue registered) novel=${novelId} trigger=${trigger}`);
    return;
  }
  queue.enqueue(novelId, trigger);
}
