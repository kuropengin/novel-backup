/** メモリ上の固定窓レート制限(キー毎)。 */
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  constructor(
    private max: number,
    private windowMs: number,
  ) {}

  /** 試行を記録し、許可されれば true。 */
  take(key: string, now = Date.now()): boolean {
    const e = this.hits.get(key);
    if (!e || e.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    e.count++;
    return e.count <= this.max;
  }

  reset(): void {
    this.hits.clear();
  }
}
