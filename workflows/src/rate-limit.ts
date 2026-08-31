export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  /** Seconds until the current window resets. */
  retryAfterSeconds: number;
}

/**
 * Fixed-window request counting.
 *
 * The interface is async because a shared implementation has to cross the
 * network; the in-process one resolves immediately.
 */
export interface RateLimiter {
  readonly shared: boolean;
  /** Counts one request against `key` and says whether it may proceed. */
  consume(key: string): Promise<RateLimitDecision>;
  close(): Promise<void>;
}

export interface RateLimiterOptions {
  windowMs: number;
  max: number;
}

/**
 * Per-process limiter.
 *
 * Each replica keeps its own counters, so N replicas allow N times the
 * configured limit. `shared` is false to make that visible rather than
 * something an operator discovers under load.
 */
export class InMemoryRateLimiter implements RateLimiter {
  readonly shared = false;
  readonly #buckets = new Map<string, { count: number; resetAt: number }>();
  readonly #sweep: NodeJS.Timeout;

  constructor(private readonly options: RateLimiterOptions) {
    this.#sweep = setInterval(() => {
      const now = Date.now();
      for (const [key, bucket] of this.#buckets) {
        if (bucket.resetAt <= now) this.#buckets.delete(key);
      }
    }, options.windowMs);
    this.#sweep.unref?.();
  }

  async consume(key: string): Promise<RateLimitDecision> {
    const now = Date.now();
    const bucket = this.#buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      this.#buckets.set(key, { count: 1, resetAt: now + this.options.windowMs });
      return { allowed: true, remaining: this.options.max - 1, retryAfterSeconds: 0 };
    }

    bucket.count += 1;
    const remaining = Math.max(0, this.options.max - bucket.count);

    return {
      allowed: bucket.count <= this.options.max,
      remaining,
      retryAfterSeconds: Math.ceil((bucket.resetAt - now) / 1000),
    };
  }

  async close(): Promise<void> {
    clearInterval(this.#sweep);
    this.#buckets.clear();
  }
}
