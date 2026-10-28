/**
 * 戻るボタンで閉じるオーバーレイ(サイドメニュー・シート・サブ画面)のスタック。
 * 開いたとき push し、閉じたときに返された関数で取り除く。
 */
const stack: { id: number; close: () => void }[] = [];
let seq = 0;

export function pushOverlay(close: () => void): () => void {
  const id = ++seq;
  stack.push({ id, close });
  return () => {
    const i = stack.findIndex((o) => o.id === id);
    if (i >= 0) stack.splice(i, 1);
  };
}

/** 最前面のオーバーレイを閉じる。閉じたら true。 */
export function closeTopOverlay(): boolean {
  const top = stack[stack.length - 1];
  if (!top) return false;
  top.close();
  return true;
}

export function hasOverlay(): boolean {
  return stack.length > 0;
}
