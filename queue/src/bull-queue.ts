import type { EnqueueOptions, JobQueue, ScheduledJob } from "@bugbaar/workflows";
import { Queue } from "bullmq";
import type { RedisOptions } from "ioredis";

export interface BullJobQueueOptions {
  /** Connection options, not a client: BullMQ must own what it opens. */
  connection: RedisOptions;
  queueName?: string;
  /** Completed jobs retained before BullMQ trims them. */
  keepCompleted?: number;
  keepFailed?: number;
  defaultAttempts?: number;
}

export interface WorkflowJobData {
  workflow: string;
  input: Record<string, unknown>;
}

export const WORKFLOW_JOB_NAME = "workflow";

/**
 * BullMQ reserves ":" as its Redis key separator and rejects it in a queue
 * name, so this is deliberately hyphenated. Use `keyPrefix` on the connection
 * to namespace environments instead.
 */
export const DEFAULT_QUEUE_NAME = "bugbaar-workflows";

/**
 * Redis-backed job queue.
 *
 * Jobs outlive the process that created them and any replica can pick them up,
 * which is the whole reason this exists. Repeating jobs use BullMQ's job
 * scheduler so exactly one replica fires each tick — the in-memory queue would
 * have every replica running its own copy.
 */
export class BullJobQueue implements JobQueue {
  readonly durable = true;
  readonly #queue: Queue<WorkflowJobData>;
  readonly #defaultAttempts: number;

  constructor(options: BullJobQueueOptions) {
    this.#defaultAttempts = options.defaultAttempts ?? 3;
    this.#queue = new Queue<WorkflowJobData>(options.queueName ?? DEFAULT_QUEUE_NAME, {
      connection: options.connection,
      defaultJobOptions: {
        // Bound history so a busy queue cannot fill Redis; the durable record
        // of what happened lives in MongoDB, not here.
        removeOnComplete: { count: options.keepCompleted ?? 100 },
        removeOnFail: { count: options.keepFailed ?? 500 },
        backoff: { type: "exponential", delay: 1_000 },
      },
    });
  }

  get name(): string {
    return this.#queue.name;
  }

  async enqueue(workflow: string, input: Record<string, unknown>, options: EnqueueOptions = {}): Promise<string> {
    const job = await this.#queue.add(
      WORKFLOW_JOB_NAME,
      { workflow, input },
      {
        delay: options.delayMs,
        attempts: options.attempts ?? this.#defaultAttempts,
        ...(options.jobId ? { jobId: options.jobId } : {}),
      },
    );

    if (!job.id) throw new Error(`BullMQ returned no id for a "${workflow}" job`);
    return job.id;
  }

  async schedule(job: ScheduledJob): Promise<void> {
    // Narrowing into a local keeps the repeat spec provably non-empty, rather
    // than asserting it after the fact.
    const repeat = job.repeat.cron
      ? { pattern: job.repeat.cron }
      : job.repeat.every
        ? { every: job.repeat.every }
        : null;

    if (!repeat) {
      throw new Error(`Scheduled job "${job.id}" needs repeat.every or repeat.cron`);
    }

    // upsertJobScheduler replaces an existing scheduler with the same id,
    // which gives the "replace, don't duplicate" semantics the interface promises.
    await this.#queue.upsertJobScheduler(job.id, repeat, {
      name: WORKFLOW_JOB_NAME,
      data: { workflow: job.workflow, input: job.input },
    });
  }

  async cancel(id: string): Promise<boolean> {
    return this.#queue.removeJobScheduler(id);
  }

  async list(): Promise<ScheduledJob[]> {
    const schedulers = await this.#queue.getJobSchedulers();

    return schedulers.map((scheduler) => {
      const data = (scheduler.template?.data ?? {}) as Partial<WorkflowJobData>;
      return {
        id: scheduler.key,
        workflow: data.workflow ?? "unknown",
        input: data.input ?? {},
        repeat: {
          ...(scheduler.every ? { every: Number(scheduler.every) } : {}),
          ...(scheduler.pattern ? { cron: scheduler.pattern } : {}),
        },
        ...(scheduler.next ? { nextRunAt: new Date(scheduler.next).toISOString() } : {}),
      };
    });
  }

  async close(): Promise<void> {
    await this.#queue.close();
  }
}
