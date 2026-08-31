import type { WorkflowRun, WorkflowRunner } from "@bugbaar/workflows";
import { Worker, type Job } from "bullmq";
import type { RedisOptions } from "ioredis";
import { DEFAULT_QUEUE_NAME, WORKFLOW_JOB_NAME, type WorkflowJobData } from "./bull-queue.js";

export interface WorkflowWorkerOptions {
  /** Connection options, not a client: BullMQ must own what it opens. */
  connection: RedisOptions;
  runner: WorkflowRunner;
  queueName?: string;
  /** Jobs processed simultaneously by this worker. */
  concurrency?: number;
  onComplete?: (run: WorkflowRun, jobId: string) => void;
  onFailed?: (error: Error, jobId: string) => void;
}

/**
 * Consumes queued workflow jobs.
 *
 * A workflow that *ran* but reported `failed` is a successful job: the engine
 * did its work and recorded the outcome. Throwing there would make BullMQ
 * retry a workflow that is deterministically failing, three times, for
 * nothing. Only an infrastructure error — an unknown workflow name, a crash —
 * is allowed to escape and trigger a retry.
 */
export function createWorkflowWorker(options: WorkflowWorkerOptions): Worker<WorkflowJobData> {
  const worker = new Worker<WorkflowJobData>(
    options.queueName ?? DEFAULT_QUEUE_NAME,
    async (job: Job<WorkflowJobData>) => {
      if (job.name !== WORKFLOW_JOB_NAME) {
        throw new Error(`Unexpected job name "${job.name}"`);
      }

      const run = await options.runner(job.data.workflow, job.data.input);
      options.onComplete?.(run, job.id ?? "unknown");

      return { runId: run.runId, status: run.status };
    },
    {
      connection: options.connection,
      concurrency: options.concurrency ?? 4,
    },
  );

  worker.on("failed", (job, error) => options.onFailed?.(error, job?.id ?? "unknown"));

  return worker;
}
