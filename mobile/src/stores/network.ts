import { ref } from "vue";
import { Network } from "@capacitor/network";

export const online = ref(true);
const listeners = new Set<() => void>();
let started = false;

/** 復帰(オフライン → オンライン)時に呼ぶコールバックを登録。解除関数を返す。 */
export function onReconnect(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export async function startNetwork() {
  if (started) return;
  started = true;
  try {
    online.value = (await Network.getStatus()).connected;
    await Network.addListener("networkStatusChange", (s) => {
      const was = online.value;
      online.value = s.connected;
      if (!was && s.connected) listeners.forEach((cb) => cb());
    });
  } catch {
    online.value = typeof navigator === "undefined" ? true : navigator.onLine;
  }
}
