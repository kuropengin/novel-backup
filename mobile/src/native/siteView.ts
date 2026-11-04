/**
 * SiteView: アプリ UI(Capacitor の WebView)の上に重ねるネイティブ WebView(サイト表示用)。
 * Android 実装は android/app/src/main/java/local/novelbackup/app/SiteViewPlugin.java。
 *
 * - top / bottom は「アプリ WebView の上端/下端からのインセット」(CSS px = dp)。
 *   この矩形の内側にだけサイトが表示され、バーなどの HTML UI はその外側に置く。
 * - ネイティブビューは HTML より前面に描画される。ダイアログ/サイドメニュー等を出す間は setVisible(false)。
 * - evaluate の result は評価結果の JSON 文字列。式が文字列を返すと二重エンコードされるので、オブジェクトを返す式にして
 *   JSON.parse する(`evaluateJson` を使う)。
 */
import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";

export interface PageEvent {
  url: string;
  title: string;
  canGoBack: boolean;
  /** pushState による画面遷移(フルロードなし)で合成された pageFinished のとき true */
  spa?: boolean;
}
export interface ScrollEvent {
  /** 現在のスクロール位置(CSS px) */
  y: number;
  /** 前回からの差分(正 = 下へスクロール) */
  dy: number;
}
export interface ExternalLinkEvent {
  /** アプリ内で開かず止めた URL(許可外ホスト/許可外スキーム) */
  url: string;
}
export interface SiteViewState {
  open: boolean;
  url: string;
  title: string;
  canGoBack: boolean;
}

/** ブロックリスト 1 件の取得・解析状況 */
export interface BlocklistStatus {
  url: string;
  /** 取り込んだブロック対象ドメイン数 */
  domains: number;
  /** キャッシュの更新時刻(エポック ms)。まだ取得できていなければ null */
  updatedAt: number | null;
  /** 取得/解析に失敗したときのメッセージ(キャッシュがあればそれで動作中)。無ければ null */
  error: string | null;
}
export interface BlocklistStatusResult {
  lists: BlocklistStatus[];
  /** ダウンロード/解析の処理中なら true */
  loading: boolean;
}

export interface SiteViewPlugin {
  open(o: { url: string; top: number; bottom: number }): Promise<void>;
  close(): Promise<void>;
  setVisible(o: { visible: boolean }): Promise<void>;
  setInsets(o: { top: number; bottom: number; animate?: boolean }): Promise<void>;
  navigate(o: { url: string }): Promise<void>;
  goBack(): Promise<{ wentBack: boolean }>;
  reload(): Promise<void>;
  getState(): Promise<SiteViewState>;
  evaluate(o: { code: string }): Promise<{ result: string }>;
  insertCss(o: { code: string }): Promise<void>;
  /**
   * 広告ブロックに使うリスト(https URL)を設定する。すぐに戻り、ダウンロードと解析はバックグラウンド。
   * 空配列で即座に無効化。端末の DNS は変更せず、サイトビューア内でドメイン一致により遮断するだけ。
   */
  setBlocklists(o: { urls: string[] }): Promise<void>;
  getBlocklistStatus(): Promise<BlocklistStatusResult>;
  addListener(e: "pageStarted" | "pageFinished", cb: (d: PageEvent) => void): Promise<PluginListenerHandle>;
  /** http/https/mailto/tel のみ。既定ブラウザ等で開く(開けなければ reject) */
  openExternal(o: { url: string }): Promise<void>;
  addListener(e: "externalLink", cb: (d: ExternalLinkEvent) => void): Promise<PluginListenerHandle>;
  addListener(e: "scroll", cb: (d: ScrollEvent) => void): Promise<PluginListenerHandle>;
}

export const SiteView = registerPlugin<SiteViewPlugin>("SiteView", {
  // vite dev(デスクトップブラウザ)用。Android では使われない
  web: () => import("./siteViewWeb").then((m) => new m.SiteViewWeb()),
});

/** 式を評価して JSON をパースして返す。失敗/undefined は null。 */
export async function evaluateJson<T>(code: string): Promise<T | null> {
  try {
    const { result } = await SiteView.evaluate({ code });
    return result && result !== "null" ? (JSON.parse(result) as T) : null;
  } catch {
    return null;
  }
}
