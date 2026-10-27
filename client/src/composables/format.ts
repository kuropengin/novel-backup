export const SITE_NAMES: Record<string, string> = { hameln: "ハーメルン", narou: "小説家になろう", kakuyomu: "カクヨム" };

export function fmtDateTime(iso: string | null | undefined, empty = "未取得"): string {
  return iso ? new Date(iso).toLocaleString("ja-JP") : empty;
}

export function fmtDate(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleDateString("ja-JP") : "";
}

/** HTML → プレーンテキスト(br / ブロック要素の終端を改行にし、ルビの読みは除く)。 */
export function htmlToPlain(html: string | null | undefined): string {
  if (!html) return "";
  const doc = new DOMParser().parseFromString(`<div id="r">${html}</div>`, "text/html");
  const root = doc.getElementById("r")!;
  root.querySelectorAll("br").forEach((b) => b.replaceWith("\n"));
  root.querySelectorAll("rt, rp").forEach((e) => e.remove());
  root.querySelectorAll("p, div, h1, h2, h3, h4, h5, h6, hr").forEach((e) => e.append("\n"));
  return (root.textContent ?? "").replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
}
