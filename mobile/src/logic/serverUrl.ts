/** サーバー URL の正規化と、平文 HTTP の安全性判定(Capacitor 非依存の純粋関数)。 */

/** "192.168.1.10:3000" → "http://..." ではなく "https://192.168.1.10:3000"。スキーム省略時は https。末尾スラッシュは除去。 */
export function normalizeServerUrl(input: string): string {
  let s = input.trim();
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  return s.replace(/\/+$/, "");
}

/** URL からホスト名(小文字・IPv6 の角括弧なし)を取り出す。不正なら ""。 */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return "";
  }
}

/** localhost / ループバック / エミュレータ / RFC1918 プライベート / *.local は「ローカルホスト」とみなす。 */
export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase();
  if (!h) return false;
  if (h === "localhost" || h === "::1" || h === "10.0.2.2" || h.endsWith(".local")) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const [a, b, c, d] = m.slice(1).map(Number);
  if ([a, b, c, d].some((n) => n > 255)) return false;
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** 平文 HTTP で、かつローカル/プライベート以外のホスト(=インターネット越しに平文で通信しうる)なら true。 */
export function isInsecureRemote(url: string): boolean {
  if (!/^http:\/\//i.test(url.trim())) return false;
  return !isPrivateHost(hostOf(url));
}
