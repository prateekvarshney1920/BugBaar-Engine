import { Redis, type RedisOptions } from "ioredis";

/**
 * Turns a Redis URL into ioredis options.
 *
 * BullMQ must be given options rather than a client instance so it owns the
 * connections it creates. Handed an instance, it duplicates it for blocking
 * commands and closes the duplicates on its own schedule — while the caller
 * closes the original — and whichever loses the race flushes its pending
 * commands as rejections nobody is listening for, on shutdown.
 */
export function toRedisOptions(url: string): RedisOptions {
  const parsed = new URL(url);
  const database = parsed.pathname.replace(/^\//, "");

  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 6379,
    ...(parsed.username ? { username: decodeURIComponent(parsed.username) } : {}),
    ...(parsed.password ? { password: decodeURIComponent(parsed.password) } : {}),
    ...(database ? { db: Number(database) } : {}),
    ...(parsed.protocol === "rediss:" ? { tls: {} } : {}),
    // Mandatory for BullMQ: its blocking commands sit open for long stretches
    // and ioredis's default retry cap would abort them.
    maxRetriesPerRequest: null,
  };
}

export interface RedisConnectionOptions {
  url: string;
  /** Prefix applied to every key, so one Redis can host several environments. */
  keyPrefix?: string;
  onLog?: (message: string, data?: Record<string, unknown>) => void;
}

/**
 * Creates the ioredis clients BullMQ and the rate limiter share.
 *
 * `maxRetriesPerRequest: null` is mandatory for BullMQ: its blocking commands
 * sit open for long stretches, and ioredis's default retry cap would abort
 * them. Setting it here keeps that requirement in one place.
 */
export function createRedisClient(options: RedisConnectionOptions): Redis {
  const settings: RedisOptions = {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: false,
    ...(options.keyPrefix ? { keyPrefix: options.keyPrefix } : {}),
    retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
  };

  const client = new Redis(options.url, settings);

  client.on("error", (error: Error) => options.onLog?.("redis error", { error: error.message }));
  client.on("ready", () => options.onLog?.("connected to Redis"));

  return client;
}

/** Resolves once the client is usable, or rejects after `timeoutMs`. */
export async function waitForRedis(client: Redis, timeoutMs = 10_000): Promise<void> {
  if (client.status === "ready") return;

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Redis did not become ready within ${timeoutMs}ms`));
    }, timeoutMs);

    const onReady = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      client.off("ready", onReady);
      client.off("error", onError);
    };

    client.once("ready", onReady);
    client.once("error", onError);
  });
}

/**
 * Closes a client without stranding pending commands.
 *
 * `disconnect()` tears the socket down immediately, so anything still in
 * flight rejects with "Connection is closed" — and because those rejections
 * have no handler, they surface as unhandled rejections during shutdown, which
 * is the worst possible moment. `quit()` drains first; the fallback covers a
 * connection that was already gone.
 */
export async function closeRedis(client: Redis): Promise<void> {
  if (client.status === "end") return;

  try {
    await client.quit();
  } catch {
    client.disconnect();
  }
}

export async function pingRedis(client: Redis): Promise<boolean> {
  try {
    return (await client.ping()) === "PONG";
  } catch {
    return false;
  }
}
