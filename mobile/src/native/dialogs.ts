import { Dialog } from "@capacitor/dialog";

/** ネイティブの確認ダイアログ(Web では window.confirm)。 */
export async function confirmNative(message: string, title = "確認", okButtonTitle = "OK"): Promise<boolean> {
  try {
    const r = await Dialog.confirm({ title, message, okButtonTitle, cancelButtonTitle: "キャンセル" });
    return r.value;
  } catch {
    return false;
  }
}
