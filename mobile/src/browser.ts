/** cordova-plugin-inappbrowser の最小型定義(必要な部分のみ)。 */
export interface IabEvent {
  type: string;
  url?: string;
  data?: unknown;
}
export interface IabInstance {
  addEventListener(type: string, cb: (e: IabEvent) => void): void;
  executeScript(script: { code: string }, cb?: (r: unknown) => void): void;
  insertCSS(css: { code: string }, cb?: () => void): void;
  close(): void;
}
interface CordovaGlobal {
  InAppBrowser?: { open(url: string, target: string, options: string): IabInstance };
}

/** 戻るボタン: ページ内で戻り、履歴が無ければ閉じる(hardwareback=yes)。ツールバー表示、ズーム無効。 */
export const IAB_OPTIONS = "location=no,toolbar=yes,hidenavigationbuttons=no,zoom=no,hardwareback=yes";

async function waitForCordova(timeoutMs = 4000): Promise<CordovaGlobal["InAppBrowser"]> {
  const start = Date.now();
  for (;;) {
    const c = (window as unknown as { cordova?: CordovaGlobal }).cordova;
    if (c?.InAppBrowser) return c.InAppBrowser;
    if (Date.now() - start > timeoutMs) throw new Error("InAppBrowser が利用できません(実機/エミュレータで実行してください)");
    await new Promise((r) => setTimeout(r, 100));
  }
}

export async function openInBrowser(url: string): Promise<IabInstance> {
  const iab = await waitForCordova();
  return iab!.open(url, "_blank", IAB_OPTIONS);
}
