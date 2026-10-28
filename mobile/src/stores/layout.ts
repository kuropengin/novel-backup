import { ref } from "vue";

/** バー本体の高さ(セーフエリアを除く、CSS px = dp) */
export const TOP_BAR_H = 52;
export const BOTTOM_BAR_H = 60;

/** セーフエリアを含めたバーの高さ。SiteView のインセットにも使う。 */
export const topH = ref(TOP_BAR_H);
export const bottomH = ref(BOTTOM_BAR_H);

/** env(safe-area-inset-*) を実測し、CSS 変数(--top-h / --bottom-h)とインセットへ反映する。 */
export function measureLayout() {
  const probe = document.createElement("div");
  probe.style.cssText = "position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)";
  document.body.appendChild(probe);
  const cs = getComputedStyle(probe);
  const sat = parseFloat(cs.paddingTop) || 0;
  const sab = parseFloat(cs.paddingBottom) || 0;
  probe.remove();
  topH.value = TOP_BAR_H + sat;
  bottomH.value = BOTTOM_BAR_H + sab;
  const root = document.documentElement.style;
  root.setProperty("--sat", `${sat}px`);
  root.setProperty("--sab", `${sab}px`);
  root.setProperty("--top-h", `${topH.value}px`);
  root.setProperty("--bottom-h", `${bottomH.value}px`);
}
