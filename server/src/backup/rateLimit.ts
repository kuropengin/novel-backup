/** 負荷制御とレート制限の実装 */

export interface RateLimitConfig {
  requestsPerSecond: number;
  burstSize?: number;
}

export class RateLimiter {
  private lastRequestTime = 0;
  private tokens: number;
  private readonly maxTokens: number;
  private readonly refillRate: number; // tokens per ms

  constructor(config: RateLimitConfig) {
    this.maxTokens = config.burstSize ?? Math.ceil(config.requestsPerSecond);
    this.tokens = this.maxTokens;
    this.refillRate = config.requestsPerSecond / 1000;
  }

  async waitForSlot(): Promise<void> {
    const now = Date.now();
    const timeSinceLastRefill = now - this.lastRequestTime;
    this.tokens = Math.min(this.maxTokens, this.tokens + timeSinceLastRefill * this.refillRate);
    this.lastRequestTime = now;

    if (this.tokens < 1) {
      const waitMs = (1 - this.tokens) / this.refillRate;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      this.tokens = 0;
    } else {
      this.tokens -= 1;
    }
  }
}

export class PriorityQueue<T extends { priority: number; createdAt: string }> {
  private items: T[] = [];

  push(item: T): void {
    this.items.push(item);
    this.items.sort((a, b) => {
      if (a.priority !== b.priority) return b.priority - a.priority;
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    });
  }

  pop(): T | undefined {
    return this.items.shift();
  }

  isEmpty(): boolean {
    return this.items.length === 0;
  }

  size(): number {
    return this.items.length;
  }

  clear(): void {
    this.items = [];
  }
}

export class ConcurrencyController {
  private running = 0;
  private readonly maxConcurrency: number;
  private waitQueue: (() => void)[] = [];

  constructor(maxConcurrency: number) {
    this.maxConcurrency = maxConcurrency;
  }

  async acquire(): Promise<void> {
    if (this.running >= this.maxConcurrency) {
      await new Promise<void>((resolve) => {
        this.waitQueue.push(resolve);
      });
    }
    this.running++;
  }

  release(): void {
    this.running--;
    const next = this.waitQueue.shift();
    if (next) next();
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}
