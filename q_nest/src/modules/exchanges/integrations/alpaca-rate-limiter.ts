/**
 * Token-bucket rate limiter for the Alpaca trading API.
 *
 * Alpaca's trading API caps at 200 RPM per account. At Option B scale with
 * many users + auto-trade firing on signal storms, we can blow through that
 * cap and get 429s on real user orders. This limiter throttles us to 180 RPM
 * (leaves headroom for unexpected bursts) and queues excess requests instead
 * of failing them outright.
 *
 * Usage:
 *   const limiter = new AlpacaRateLimiter();
 *   await limiter.acquire();
 *   const res = await client.post('/v2/orders', ...);
 */

const RPM_CAP = 180;                    // tokens added per minute
const BUCKET_CAPACITY = 200;            // max accumulated tokens
const REFILL_INTERVAL_MS = 60_000 / RPM_CAP; // ~333ms per token

export class AlpacaRateLimiter {
  private tokens = BUCKET_CAPACITY;
  private lastRefill = Date.now();
  private readonly queue: Array<() => void> = [];

  /**
   * Wait until a token is available, then consume one and continue.
   * Resolves in order — queued requests are served FIFO.
   */
  async acquire(): Promise<void> {
    this.refill();

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }

    // No tokens available; queue and wait
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
      this.scheduleRefill();
    });
  }

  /**
   * Snapshot for diagnostics / monitoring.
   */
  getStats(): { tokens: number; queued: number; capacity: number; rpmCap: number } {
    this.refill();
    return {
      tokens: Math.floor(this.tokens),
      queued: this.queue.length,
      capacity: BUCKET_CAPACITY,
      rpmCap: RPM_CAP,
    };
  }

  private refill(): void {
    const now = Date.now();
    const elapsedMs = now - this.lastRefill;
    if (elapsedMs <= 0) return;

    const tokensToAdd = (elapsedMs / 60_000) * RPM_CAP;
    this.tokens = Math.min(BUCKET_CAPACITY, this.tokens + tokensToAdd);
    this.lastRefill = now;

    // Drain queued waiters while we have tokens
    while (this.tokens >= 1 && this.queue.length > 0) {
      this.tokens -= 1;
      const resolve = this.queue.shift()!;
      resolve();
    }
  }

  private scheduleRefill(): void {
    setTimeout(() => this.refill(), REFILL_INTERVAL_MS);
  }
}

// Singleton — one bucket per process. The whole app shares one Alpaca account
// so this is the right scope.
export const alpacaTradingRateLimiter = new AlpacaRateLimiter();
