import type { WorkflowRun } from "./types.js";

/** Executes a workflow by name. Supplied by whoever owns the workflow registry. */
export type WorkflowRunner = (workflow: string, input: Record<string, unknown>) => Promise<WorkflowRun>;

export interface EnqueueOptions {
  /** Delay before the job becomes eligible to run. */
  delayMs?: number;
  /**
   * Queue-level retries — distinct from a step's own `retry` policy. A step
   * retry handles a flaky operation; a job retry handles the worker dying
   * mid-run.
   */
  attempts?: number;
  /** Supply your own id to make enqueueing idempotent. */
  jobId?: string;
}

export interface RepeatOptions {
  /** Interval in milliseconds. */
  every?: number;
  /** Cron expression, evaluated in the worker's timezone. */
  cron?: string;
}

export interface ScheduledJob {
  id: string;
  workflow: string;
  input: Record<string, unknown>;
  repeat: RepeatOptions;
  nextRunAt?: string;
}

/**
 * Background execution of workflows.
 *
 * `durable` tells callers what they are actually getting: an in-process queue
 * loses everything on restart and cannot span replicas, so the API reports it
 * rather than letting operators assume otherwise.
 */
export interface JobQueue {
  readonly durable: boolean;
  /** Queues a one-off run and returns its job id. */
  enqueue(workflow: string, input: Record<string, unknown>, options?: EnqueueOptions): Promise<string>;
  /** Registers a repeating job, replacing any existing job with the same id. */
  schedule(job: ScheduledJob): Promise<void>;
  cancel(id: string): Promise<boolean>;
  list(): Promise<ScheduledJob[]>;
  close(): Promise<void>;
}

export interface InMemoryJobQueueOptions {
  runner: WorkflowRunner;
  onError?: (error: unknown, jobId: string) => void;
  onComplete?: (run: WorkflowRun, jobId: string) => void;
}

/**
 * Timer-backed queue used when Redis is not configured.
 *
 * Jobs live only in this process: they do not survive a restart and a second
 * replica would run its own copy of every repeating job. It exists so the
 * engine works with zero infrastructure, not as a production queue.
 */
export class InMemoryJobQueue implements JobQueue {
  readonly durable = false;
  readonly #intervals = new Map<string, NodeJS.Timeout>();
  /** Pending one-off and retry timers, so close() can cancel work in flight. */
  readonly #pending = new Set<NodeJS.Timeout>();
  readonly #jobs = new Map<string, ScheduledJob>();
  readonly #running = new Set<string>();
  readonly #options: InMemoryJobQueueOptions;
  #sequence = 0;
  #closed = false;

  constructor(options: InMemoryJobQueueOptions) {
    this.#options = options;
  }

  async enqueue(workflow: string, input: Record<string, unknown>, options: EnqueueOptions = {}): Promise<string> {
    const id = options.jobId ?? `job-${++this.#sequence}`;
    this.#later(
      () => void this.#attempt(id, workflow, input, 1, Math.max(1, options.attempts ?? 1)),
      options.delayMs ?? 0,
    );
    return id;
  }

  async schedule(job: ScheduledJob): Promise<void> {
    if (!job.repeat.every) {
      throw new Error("InMemoryJobQueue supports repeat.every only — cron requires the Redis-backed queue");
    }

    await this.cancel(job.id);

    const timer = setInterval(() => void this.#attempt(job.id, job.workflow, job.input, 1, 1), job.repeat.every);
    timer.unref?.();

    this.#intervals.set(job.id, timer);
    this.#jobs.set(job.id, { ...job, nextRunAt: new Date(Date.now() + job.repeat.every).toISOString() });
  }

  async cancel(id: string): Promise<boolean> {
    const timer = this.#intervals.get(id);
    if (!timer) return false;

    clearInterval(timer);
    this.#intervals.delete(id);
    this.#jobs.delete(id);
    return true;
  }

  async list(): Promise<ScheduledJob[]> {
    return [...this.#jobs.values()];
  }

  /**
   * Cancels every timer, including one-off and retry timers.
   *
   * Tracking those matters: a delayed job that survives close() runs after the
   * process has torn down the connections it needs, so it either crashes or
   * silently loses the work.
   */
  async close(): Promise<void> {
    this.#closed = true;

    for (const timer of this.#intervals.values()) clearInterval(timer);
    for (const timer of this.#pending) clearTimeout(timer);

    this.#intervals.clear();
    this.#pending.clear();
    this.#jobs.clear();
  }

  #later(action: () => void, delayMs: number): void {
    if (this.#closed) return;

    const timer = setTimeout(() => {
      this.#pending.delete(timer);
      action();
    }, delayMs);
    timer.unref?.();
    this.#pending.add(timer);
  }

  /**
   * Runs a job, retrying on failure up to `maxAttempts` with the same
   * exponential backoff the Redis queue uses.
   *
   * A job never overlaps itself: a tick arriving mid-run is dropped, not
   * queued.
   */
  async #attempt(
    id: string,
    workflow: string,
    input: Record<string, unknown>,
    attempt: number,
    maxAttempts: number,
  ): Promise<void> {
    if (this.#closed || this.#running.has(id)) return;
    this.#running.add(id);

    try {
      const run = await this.#options.runner(workflow, input);
      this.#options.onComplete?.(run, id);

      const job = this.#jobs.get(id);
      if (job?.repeat.every) {
        this.#jobs.set(id, { ...job, nextRunAt: new Date(Date.now() + job.repeat.every).toISOString() });
      }
    } catch (error) {
      if (attempt < maxAttempts && !this.#closed) {
        const backoff = 1_000 * 2 ** (attempt - 1);
        this.#later(() => void this.#attempt(id, workflow, input, attempt + 1, maxAttempts), backoff);
      } else {
        this.#options.onError?.(error, id);
      }
    } finally {
      this.#running.delete(id);
    }
  }
}
