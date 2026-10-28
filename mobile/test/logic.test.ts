import { describe, expect, it } from "vitest";
import { ScrollHideController } from "../src/logic/scrollHide";
import { enqueue, flushQueue, sanitizeQueue, type QueuedView } from "../src/logic/historyQueue";
import { filterBookmarks, formatDate, initialOf, offlineOnly, relativeTime, sortBookmarks, type BookmarkLike } from "../src/logic/lists";
import { addNotification, markAllRead, markRead, removeNotification, sanitizeNotifications, unreadCount, MAX_NOTIFICATIONS } from "../src/logic/notifications";
import { classifyUrl } from "../src/logic/sites";

describe("ScrollHideController", () => {
  it("しきい値(8px)未満では隠さない / 超えたら隠す", () => {
    const c = new ScrollHideController();
    expect(c.feed(5, 100, 0)).toBeNull();
    expect(c.feed(2, 107, 1)).toBeNull();
    expect(c.feed(2, 109, 2)).toBe(true);
    expect(c.hidden).toBe(true);
  });
  it("変化直後 250ms は無視し、その後の上スクロールで戻す", () => {
    const c = new ScrollHideController();
    c.feed(10, 100, 0);
    expect(c.feed(-20, 80, 100)).toBeNull(); // ロック中
    expect(c.hidden).toBe(true);
    expect(c.feed(-5, 75, 300)).toBeNull();
    expect(c.feed(-5, 70, 301)).toBe(false);
  });
  it("向きが変わると累積をやり直す(ジッターで切り替わらない)", () => {
    const c = new ScrollHideController();
    expect(c.feed(6, 50, 0)).toBeNull();
    expect(c.feed(-3, 47, 1)).toBeNull();
    expect(c.feed(6, 53, 2)).toBeNull();
    expect(c.hidden).toBe(false);
  });
  it("先頭(y<=0)に戻ると表示する", () => {
    const c = new ScrollHideController();
    c.feed(20, 200, 0);
    expect(c.feed(-200, 0, 1000)).toBe(false);
  });
  it("reset は即座に表示へ戻す", () => {
    const c = new ScrollHideController();
    c.feed(20, 200, 0);
    expect(c.reset()).toBe(true);
    expect(c.reset()).toBe(false);
    expect(c.feed(10, 210, 1)).toBe(true); // ロックも解除されている
  });
});

describe("historyQueue", () => {
  const v = (url: string, at: string): QueuedView => ({ url, novelTitle: "n", episodeTitle: "", viewedAt: at });
  it("enqueue は同じ URL を最新 1 件にし、上限で古いものを捨てる", () => {
    let q: QueuedView[] = [];
    q = enqueue(q, v("a", "2026-01-01T00:00:00Z"));
    q = enqueue(q, v("b", "2026-01-01T00:01:00Z"));
    q = enqueue(q, v("a", "2026-01-01T00:02:00Z"));
    expect(q.map((x) => x.url)).toEqual(["b", "a"]);
    q = enqueue(q, v("c", "2026-01-01T00:03:00Z"), 2);
    expect(q.map((x) => x.url)).toEqual(["a", "c"]);
  });
  it("flushQueue は古い順に送り、retry で中断して残りを返す", async () => {
    const q = [v("b", "2026-01-02T00:00:00Z"), v("a", "2026-01-01T00:00:00Z"), v("c", "2026-01-03T00:00:00Z")];
    const sent: string[] = [];
    const rest = await flushQueue(q, async (x) => {
      sent.push(x.url);
      return x.url === "b" ? "retry" : "ok";
    });
    expect(sent).toEqual(["a", "b"]);
    expect(rest.map((x) => x.url)).toEqual(["b", "c"]);
  });
  it("drop は捨てて続行、stop は中断", async () => {
    const q = [v("a", "2026-01-01T00:00:00Z"), v("b", "2026-01-02T00:00:00Z"), v("c", "2026-01-03T00:00:00Z")];
    expect(await flushQueue(q, async (x) => (x.url === "a" ? "drop" : "ok"))).toEqual([]);
    expect((await flushQueue(q, async () => "stop")).length).toBe(3);
  });
  it("sanitizeQueue は不正な要素を除く", () => {
    expect(sanitizeQueue("x")).toEqual([]);
    expect(sanitizeQueue([{ url: "u", viewedAt: "t" }, { url: 1 }, null])).toEqual([{ url: "u", viewedAt: "t", novelTitle: "", episodeTitle: "" }]);
  });
});

describe("bookmark list helpers", () => {
  const items: BookmarkLike[] = [
    { id: 1, site: "narou", title: "ぼうけん", author: "山田", createdAt: "2026-01-01T00:00:00Z" },
    { id: 2, site: "kakuyomu", title: "あさ", author: "鈴木", createdAt: "2026-02-01T00:00:00Z" },
    { id: 3, site: "hameln", title: "うみ", author: "山田", createdAt: "2026-03-01T00:00:00Z" },
  ];
  it("タイトル・作者・サイト名で絞り込む(AND、大小無視)", () => {
    expect(filterBookmarks(items, "山田").map((b) => b.id)).toEqual([1, 3]);
    expect(filterBookmarks(items, "カクヨム").map((b) => b.id)).toEqual([2]);
    expect(filterBookmarks(items, "NAROU").map((b) => b.id)).toEqual([1]);
    expect(filterBookmarks(items, "山田 うみ").map((b) => b.id)).toEqual([3]);
    expect(filterBookmarks(items, "  ").length).toBe(3);
  });
  it("追加日 / 更新日(代用) / タイトル / サイトで並べ替える", () => {
    expect(sortBookmarks(items, "added", "desc").map((b) => b.id)).toEqual([3, 2, 1]);
    expect(sortBookmarks(items, "added", "asc").map((b) => b.id)).toEqual([1, 2, 3]);
    expect(sortBookmarks(items, "updated", "desc").map((b) => b.id)).toEqual([3, 2, 1]);
    expect(sortBookmarks(items, "title", "asc").map((b) => b.id)).toEqual([2, 3, 1]);
    expect(sortBookmarks(items, "site", "asc").map((b) => b.site)).toEqual(["hameln", "kakuyomu", "narou"]);
  });
  it("入力を破壊しない / オフラインでは保存済みのみ(今回は空)", () => {
    const copy = [...items];
    sortBookmarks(items, "title", "desc");
    expect(items).toEqual(copy);
    expect(offlineOnly(items)).toEqual([]);
    expect(offlineOnly([{ ...items[0]!, offlineSaved: true }]).length).toBe(1);
  });
});

describe("time / name helpers", () => {
  const now = Date.parse("2026-10-28T12:00:00Z");
  it("relativeTime", () => {
    expect(relativeTime("2026-10-28T11:59:40Z", now)).toBe("たった今");
    expect(relativeTime("2026-10-28T11:30:00Z", now)).toBe("30分前");
    expect(relativeTime("2026-10-28T09:00:00Z", now)).toBe("3時間前");
    expect(relativeTime("2026-10-26T12:00:00Z", now)).toBe("2日前");
    expect(relativeTime("2026-01-05T12:00:00Z", now)).toMatch(/^2026\/1\/\d+$/);
    expect(relativeTime("bad", now)).toBe("");
    expect(formatDate("bad")).toBe("");
  });
  it("initialOf", () => {
    expect(initialOf("alice")).toBe("A");
    expect(initialOf("  ")).toBe("?");
    expect(initialOf("山田")).toBe("山");
  });
});

describe("notifications store", () => {
  it("追加・既読・削除・未読数", () => {
    let l = addNotification([], { kind: "backup-done", title: "完了", body: "x" }, "1", new Date("2026-01-01T00:00:00Z"));
    l = addNotification(l, { kind: "k", title: "二つ目" }, "2");
    expect(l.map((n) => n.id)).toEqual(["2", "1"]);
    expect(unreadCount(l)).toBe(2);
    l = markRead(l, "1");
    expect(unreadCount(l)).toBe(1);
    expect(l[1]!.read).toBe(true);
    l = markAllRead(l);
    expect(unreadCount(l)).toBe(0);
    expect(removeNotification(l, "2").map((n) => n.id)).toEqual(["1"]);
  });
  it("上限を超えたら古いものを捨てる / 不正な保存値を除く", () => {
    let l: ReturnType<typeof addNotification> = [];
    for (let i = 0; i < MAX_NOTIFICATIONS + 5; i++) l = addNotification(l, { kind: "k", title: String(i) }, String(i));
    expect(l.length).toBe(MAX_NOTIFICATIONS);
    expect(l[0]!.title).toBe(String(MAX_NOTIFICATIONS + 4));
    expect(sanitizeNotifications([{ id: "a", title: "t", createdAt: "x" }, { id: 1 }])).toEqual([{ id: "a", kind: "", title: "t", body: "", createdAt: "x", read: false }]);
  });
});

describe("classifyUrl", () => {
  it("作品/話ページを判定し、それ以外は null", () => {
    expect(classifyUrl("https://ncode.syosetu.com/n1234ab/")).toEqual({ site: "narou", kind: "novel" });
    expect(classifyUrl("https://ncode.syosetu.com/n1234ab/12/")).toEqual({ site: "narou", kind: "episode" });
    expect(classifyUrl("https://kakuyomu.jp/works/123")).toEqual({ site: "kakuyomu", kind: "novel" });
    expect(classifyUrl("https://kakuyomu.jp/works/123/episodes/456")).toEqual({ site: "kakuyomu", kind: "episode" });
    expect(classifyUrl("https://syosetu.org/novel/298/")).toEqual({ site: "hameln", kind: "novel" });
    expect(classifyUrl("https://syosetu.org/novel/298/12.html")).toEqual({ site: "hameln", kind: "episode" });
    expect(classifyUrl("https://syosetu.org/?mode=ss_detail&nid=298")).toEqual({ site: "hameln", kind: "novel" });
    expect(classifyUrl("https://yomou.syosetu.com/")).toBeNull();
    expect(classifyUrl("https://kakuyomu.jp/")).toBeNull();
    expect(classifyUrl("nope")).toBeNull();
  });
});
