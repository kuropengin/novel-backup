/**
 * X 風のバー自動非表示の判定。下スクロールが threshold(px)を超えたら隠し、上スクロールで戻す。
 * 状態が変わった直後は lockMs の間スクロールイベントを無視する
 * (SiteView の表示領域をアニメーションで変えると WebView のスクロールが揺れて、フィードバックするため)。
 */
export interface ScrollHideOptions {
  threshold?: number;
  lockMs?: number;
}

export class ScrollHideController {
  hidden = false;
  private acc = 0;
  private lockUntil = 0;
  private readonly threshold: number;
  private readonly lockMs: number;

  constructor(opts: ScrollHideOptions = {}) {
    this.threshold = opts.threshold ?? 8;
    this.lockMs = opts.lockMs ?? 250;
  }

  /**
   * @param dy 前回からの差分(正 = 下へスクロール)
   * @param y 現在のスクロール位置
   * @param now 現在時刻(ms)
   * @returns 状態が変わったときだけ新しい hidden、変わらなければ null
   */
  feed(dy: number, y: number, now: number): boolean | null {
    if (now < this.lockUntil) {
      this.acc = 0;
      return null;
    }
    if (y <= 0) {
      this.acc = 0;
      return this.hidden ? this.set(false, now) : null;
    }
    if (dy === 0) return null;
    // 向きが変わったら累積をやり直す
    if (this.acc !== 0 && dy > 0 !== this.acc > 0) this.acc = 0;
    this.acc += dy;
    if (!this.hidden && this.acc >= this.threshold) return this.set(true, now);
    if (this.hidden && this.acc <= -this.threshold) return this.set(false, now);
    return null;
  }

  /** ページ遷移・タブ切替などで強制的に表示へ戻す(ロックなし)。変わったら true。 */
  reset(): boolean {
    const changed = this.hidden;
    this.hidden = false;
    this.acc = 0;
    this.lockUntil = 0;
    return changed;
  }

  private set(h: boolean, now: number): boolean {
    this.hidden = h;
    this.acc = 0;
    this.lockUntil = now + this.lockMs;
    return h;
  }
}
