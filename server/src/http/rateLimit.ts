import type { Request } from "express";

/** メモリ上の固定窓レート制限(キー毎)。期限切れエントリは定期的に掃除する(Map の無制限な増加を防ぐ)。 */
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  private nextPurgeAt = 0;
  constructor(
    private max: number,
    private windowMs: number,
    /** 保持するキー数の上限。超えたら古い順に捨てる */
    private maxKeys = 10_000,
  ) {}

  /** 試行を記録し、許可されれば true。 */
  take(key: string, now = Date.now()): boolean {
    this.purge(now);
    const e = this.hits.get(key);
    if (!e || e.resetAt <= now) {
      this.hits.delete(key);
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    e.count++;
    return e.count <= this.max;
  }

  /** 制限中なら解除までの秒数(切り上げ)。制限中でなければ 0。 */
  retryAfterSec(key: string, now = Date.now()): number {
    const e = this.hits.get(key);
    if (!e || e.resetAt <= now || e.count <= this.max) return 0;
    return Math.max(1, Math.ceil((e.resetAt - now) / 1000));
  }

  /** 現在のキー数(テスト・監視用) */
  get size(): number {
    return this.hits.size;
  }

  private purge(now: number): void {
    if (now >= this.nextPurgeAt || this.hits.size > this.maxKeys) {
      this.nextPurgeAt = now + Math.min(this.windowMs, 60_000);
      for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
      // それでも多ければ挿入順(古い順)に捨てる
      for (const k of this.hits.keys()) {
        if (this.hits.size <= this.maxKeys) break;
        this.hits.delete(k);
      }
    }
  }

  reset(): void {
    this.hits.clear();
  }
}

/**
 * 失敗回数に応じた指数バックオフ(ユーザー名単位のロックアウト)。
 * 失敗が threshold 回に達すると baseMs ロックし、以降は失敗の度に 2 倍(上限 maxMs)。成功で解除。
 */
export class FailureBackoff {
  private entries = new Map<string, { fails: number; lockedUntil: number; lastAt: number }>();
  private nextPurgeAt = 0;
  constructor(
    private threshold = 5,
    private baseMs = 60_000,
    private maxMs = 15 * 60_000,
    private maxKeys = 10_000,
  ) {}

  /** ロック中なら残り秒数(切り上げ)。ロック中でなければ 0。 */
  lockedFor(key: string, now = Date.now()): number {
    const e = this.entries.get(key);
    if (!e || e.lockedUntil <= now) return 0;
    return Math.ceil((e.lockedUntil - now) / 1000);
  }

  /** 失敗を記録する(ロック中の試行も含めて呼ばない前提)。 */
  fail(key: string, now = Date.now()): void {
    this.purge(now);
    const e = this.entries.get(key) ?? { fails: 0, lockedUntil: 0, lastAt: now };
    e.fails++;
    e.lastAt = now;
    if (e.fails >= this.threshold) {
      e.lockedUntil = now + Math.min(this.maxMs, this.baseMs * 2 ** (e.fails - this.threshold));
    }
    this.entries.delete(key);
    this.entries.set(key, e);
  }

  success(key: string): void {
    this.entries.delete(key);
  }

  private purge(now: number): void {
    if (now >= this.nextPurgeAt || this.entries.size > this.maxKeys) {
      this.nextPurgeAt = now + 60_000;
      // 最後の失敗から maxMs 以上経過し、ロックも切れたものは忘れる
      for (const [k, v] of this.entries) if (v.lockedUntil <= now && now - v.lastAt > this.maxMs) this.entries.delete(k);
      for (const k of this.entries.keys()) {
        if (this.entries.size <= this.maxKeys) break;
        this.entries.delete(k);
      }
    }
  }
}

/** レート制限用のクライアント識別キー。IPv6 は /64 単位に丸める(アドレス切替による回避を防ぐ)。 */
export function ipKey(ip: string | undefined): string {
  if (!ip) return "unknown";
  let a = ip.trim().toLowerCase();
  const zone = a.indexOf("%");
  if (zone >= 0) a = a.slice(0, zone);
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (mapped) return mapped[1]!;
  if (!a.includes(":")) return a;
  let groups: string[];
  const dbl = a.indexOf("::");
  if (dbl >= 0) {
    const head = a.slice(0, dbl).split(":").filter(Boolean);
    const tail = a.slice(dbl + 2).split(":").filter(Boolean);
    groups = [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill("0"), ...tail];
  } else {
    groups = a.split(":");
  }
  return groups.slice(0, 4).map((g) => (g || "0").replace(/^0+(?=.)/, "")).join(":") + "::/64";
}

export function clientKey(req: Request): string {
  return ipKey(req.ip);
}
