import type { RateLimiter, RateLimiterOptions, RateLimitDecision } from "@bugbaar/workflows";
import type { Redis } from "ioredis";

export interface RedisRateLimiterOptions extends RateLimiterOptions {
  connection: Redis;
  keyPrefix?: string;
}

/**
 * Fixed-window limiter shared by every replica.
 *
 * INCR and PEXPIRE go in one Lua script so they are atomic: as two round
 * trips, a process dying between them leaves a counter with no TTL, which
 * would lock that key out forever.
 *
 * The script returns the count *and* the remaining TTL, so a decision costs a
 * single round trip.
 */
const CONSUME_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return { current, redis.call('PTTL', KEYS[1]) }
`;

export class RedisRateLimiter implements RateLimiter {
  readonly shared = true;
  readonly #connection: Redis;
  readonly #prefix: string;
  readonly #windowMs: number;
  readonly #max: number;

  constructor(options: RedisRateLimiterOptions) {
    this.#connection = options.connection;
    this.#prefix = options.keyPrefix ?? "bugbaar:ratelimit:";
    this.#windowMs = options.windowMs;
    this.#max = options.max;
  }

  async consume(key: string): Promise<RateLimitDecision> {
    const [count, ttl] = (await this.#connection.eval(
      CONSUME_SCRIPT,
      1,
      `${this.#prefix}${key}`,
      String(this.#windowMs),
    )) as [number, number];

    return {
      allowed: count <= this.#max,
      remaining: Math.max(0, this.#max - count),
      retryAfterSeconds: Math.max(1, Math.ceil(ttl / 1000)),
    };
  }

  async close(): Promise<void> {
    // The connection is owned by whoever created it and may be shared with the
    // queue, so closing it is not this class's decision.
  }
}
