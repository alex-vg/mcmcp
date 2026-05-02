/** Result of a token-bucket consumption attempt. */
export interface RateCheck {
  allowed: boolean;
  /** Approx seconds until the next token would be available. */
  retryAfterSeconds: number;
  /** Configured requests-per-minute, for diagnostics. */
  requestsPerMinute: number;
}

interface Bucket {
  rpm: number;
  tokens: number;
  lastRefillMs: number;
}

/**
 * Per-upstream token-bucket rate limiter. Each upstream has at most
 * one bucket sized to `requestsPerMinute`, refilled continuously.
 *
 * `tryConsume` is non-blocking: it returns immediately and does not
 * await refill. Concurrent races are tolerated (acceptable fidelity per
 * spec).
 */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  /** Configure (or reconfigure) an upstream's bucket. Pass undefined to
   *  remove the limit entirely. */
  configure(upstreamId: string, requestsPerMinute: number | undefined): void {
    if (!requestsPerMinute || requestsPerMinute <= 0) {
      this.buckets.delete(upstreamId);
      return;
    }
    const existing = this.buckets.get(upstreamId);
    this.buckets.set(upstreamId, {
      rpm: requestsPerMinute,
      tokens: existing ? Math.min(existing.tokens, requestsPerMinute) : requestsPerMinute,
      lastRefillMs: Date.now(),
    });
  }

  /** Drop a bucket, e.g. when an upstream is removed. */
  remove(upstreamId: string): void {
    this.buckets.delete(upstreamId);
  }

  private refill(b: Bucket, now: number): void {
    const elapsedMs = now - b.lastRefillMs;
    if (elapsedMs <= 0) return;
    const refill = (elapsedMs / 60_000) * b.rpm;
    b.tokens = Math.min(b.rpm, b.tokens + refill);
    b.lastRefillMs = now;
  }

  /** Attempt to consume one token. Returns immediately. */
  tryConsume(upstreamId: string): RateCheck {
    const b = this.buckets.get(upstreamId);
    if (!b) {
      return { allowed: true, retryAfterSeconds: 0, requestsPerMinute: 0 };
    }
    const now = Date.now();
    this.refill(b, now);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { allowed: true, retryAfterSeconds: 0, requestsPerMinute: b.rpm };
    }
    const needed = 1 - b.tokens;
    const secondsPerToken = 60 / b.rpm;
    const retryAfterSeconds = Math.max(1, Math.ceil(needed * secondsPerToken));
    return { allowed: false, retryAfterSeconds, requestsPerMinute: b.rpm };
  }
}
