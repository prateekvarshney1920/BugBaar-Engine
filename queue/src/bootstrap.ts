import type { JobQueue, RateLimiter, WorkflowRun, WorkflowRunner } from "@bugbaar/workflows";
import type { Worker } from "bullmq";
import { BullJobQueue, DEFAULT_QUEUE_NAME } from "./bull-queue.js";
import { closeRedis, createRedisClient, pingRedis, toRedisOptions, waitForRedis } from "./connection.js";
import { RedisRateLimiter } from "./rate-limit.js";
import { createWorkflowWorker } from "./worker.js";

export interface QueueLayer {
  queue: JobQueue;
  rateLimiter: RateLimiter;
  /** Null when this process was started as a producer only. */
  worker: Worker | null;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export interface CreateQueueOptions {
  url: string;
  runner: WorkflowRunner;
  queueName?: string;
  keyPrefix?: string;
  concurrency?: number;
  rateLimit: { windowMs: number; max: number };
  /** Set false to enqueue without consuming — for a dedicated API tier. */
  startWorker?: boolean;
  connectTimeoutMs?: number;
  onLog?: (message: string, data?: Record<string, unknown>) => void;
  onRun?: (run: WorkflowRun, jobId: string) => void;
  onError?: (error: Error, jobId: string) => void;
}

/**
 * Connects to Redis and returns the queue, rate limiter, and worker.
 *
 * BullMQ is given connection *options*, so it opens and closes its own
 * clients. The single explicit client here belongs to the rate limiter and the
 * health ping — things this code owns end to end.
 */
export async function createQueue(options: CreateQueueOptions): Promise<QueueLayer> {
  const connection = createRedisClient({ url: options.url, keyPrefix: options.keyPrefix, onLog: options.onLog });
  await waitForRedis(connection, options.connectTimeoutMs);

  const redisOptions = toRedisOptions(options.url);
  const queue = new BullJobQueue({ connection: redisOptions, queueName: options.queueName });
  const rateLimiter = new RedisRateLimiter({
    connection,
    windowMs: options.rateLimit.windowMs,
    max: options.rateLimit.max,
  });

  let worker: Worker | null = null;

  if (options.startWorker !== false) {
    worker = createWorkflowWorker({
      connection: redisOptions,
      runner: options.runner,
      queueName: options.queueName,
      concurrency: options.concurrency,
      onComplete: options.onRun,
      onFailed: options.onError,
    });
    options.onLog?.("workflow worker started", { queue: options.queueName ?? DEFAULT_QUEUE_NAME });
  }

  return {
    queue,
    rateLimiter,
    worker,
    ping: () => pingRedis(connection),
    async close() {
      // Close the worker first so it stops claiming jobs, then the queue.
      // Both own their connections and shut them down cleanly.
      await worker?.close();
      await queue.close();
      await rateLimiter.close();

      // Drain rather than sever: an abrupt disconnect leaves pending commands
      // rejecting with no handler, at the worst possible moment.
      await closeRedis(connection);
    },
  };
}
