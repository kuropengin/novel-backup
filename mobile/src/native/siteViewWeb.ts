import { WebPlugin } from "@capacitor/core";
import type { SiteViewPlugin, SiteViewState } from "./siteView";

/**
 * Web フォールバック(vite dev 用)。デスクトップブラウザでは WebView を重ねられないので、
 * open / navigate は新規タブで URL を開き、他の操作は何もしない。
 */
export class SiteViewWeb extends WebPlugin implements SiteViewPlugin {
  private url = "";
  private isOpen = false;

  async open(o: { url: string; top: number; bottom: number }): Promise<void> {
    this.url = o.url;
    this.isOpen = true;
    window.open(o.url, "_blank", "noopener");
  }
  async close(): Promise<void> {
    this.isOpen = false;
  }
  async setVisible(_o: { visible: boolean }): Promise<void> {}
  async setInsets(_o: { top: number; bottom: number; animate?: boolean }): Promise<void> {}
  async navigate(o: { url: string }): Promise<void> {
    this.url = o.url;
    window.open(o.url, "_blank", "noopener");
  }
  async goBack(): Promise<{ wentBack: boolean }> {
    return { wentBack: false };
  }
  async reload(): Promise<void> {}
  async getState(): Promise<SiteViewState> {
    return { open: this.isOpen, url: this.url, title: "", canGoBack: false };
  }
  async evaluate(_o: { code: string }): Promise<{ result: string }> {
    return { result: "null" };
  }
  async insertCss(_o: { code: string }): Promise<void> {}

}
