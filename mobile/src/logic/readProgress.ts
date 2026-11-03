/** 読書進捗の純粋関数(続きから読む対象の決定など)。 */

/** 「続きから読む」で開く話の index。最後に読んだ話の次の未読 → 最初の未読 → 先頭。話がなければ -1。 */
export function resumeIndex(keys: readonly string[], read: ReadonlySet<string>, lastReadKey: string | null | undefined): number {
  if (keys.length === 0) return -1;
  const last = lastReadKey ? keys.indexOf(lastReadKey) : -1;
  if (last >= 0) {
    for (let i = last + 1; i < keys.length; i++) if (!read.has(keys[i])) return i;
  }
  const first = keys.findIndex((k) => !read.has(k));
  return first >= 0 ? first : 0;
}
