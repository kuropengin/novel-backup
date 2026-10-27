import { baseCss, minimalCss, starCss } from "./base.css";
import { PALETTES } from "./palette";
import type { DisplaySettings } from "./settings";
import { hameln } from "./sites/hameln.css";
import { kakuyomu } from "./sites/kakuyomu.css";
import { narou } from "./sites/narou.css";
import type { SiteTheme } from "./sites/common";

export * from "./palette";
export * from "./settings";
export { NAROU_AD_SELECTORS } from "./sites/narou.css";
export { KAKUYOMU_AD_SELECTORS } from "./sites/kakuyomu.css";
export { HAMELN_AD_SELECTORS } from "./sites/hameln.css";

const SITES: readonly SiteTheme[] = [narou, kakuyomu, hameln];

/** ホスト名から対象サイトを判定。3 サイト以外は null(CSS を注入しない)。 */
export function siteOfHost(hostname: string): SiteTheme | null {
  const h = hostname.toLowerCase();
  return SITES.find((s) => s.hostPattern.test(h)) ?? null;
}

export function siteOfUrl(url: string): SiteTheme | null {
  try {
    return siteOfHost(new URL(url).hostname);
  } catch {
    return null;
  }
}

/** loadstop 用の完全な CSS。対象外ホストは空文字。 */
export function buildCss(hostname: string, d: DisplaySettings): string {
  const site = siteOfHost(hostname);
  if (!site) return "";
  const p = PALETTES[d.theme];
  const parts = [baseCss(p, d.theme === "dark"), site.css(p, d), starCss(p)];
  if (d.hideAds) parts.push(`${site.adSelectors.join(",\n")}{display:none !important;}`);
  return parts.join("\n");
}

/** loadstart 用の最小 CSS(背景色のみ)。対象外ホストは空文字。 */
export function buildMinimalCss(hostname: string, d: DisplaySettings): string {
  return siteOfHost(hostname) ? minimalCss(PALETTES[d.theme]) : "";
}
