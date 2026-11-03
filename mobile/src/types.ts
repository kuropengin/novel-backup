export type Tab = "home" | "bookmarks" | "history" | "notifications";

/** リーダーで開く小説(ナビゲーション履歴にも保存される) */
export interface ReaderTarget {
  site: "narou" | "kakuyomu" | "hameln";
  novelKey: string;
  title: string;
  author?: string;
  preferOffline?: boolean;
  /** 小説の最終バックアップ日時(ISO) */
  backupAt?: string | null;
  /** 表示中の話(戻る操作で同じ話を復元する) */
  episodeKey?: string;
  /** true なら話を指定せず、続きから(最後に読んだ話の次の未読)を開く */
  resume?: boolean;
}
