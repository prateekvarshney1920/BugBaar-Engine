import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { JobQueue } from "./queue.js";
import type { WorkflowRun } from "./types.js";

/**
 * The behaviour every JobQueue must exhibit, regardless of backend.
 *
 * `InMemoryJobQueue` and `BullJobQueue` had already drifted: the interface
 * documents queue-level retries and the Redis implementation honoured them,
 * while the in-memory one silently ignored `attempts`. Callers that tested
 * locally got no retries and had no way to find out.
 *
 * Same lesson as the vector-store contract — two implementations of one
 * interface need one suite, or they diverge quietly.
 */

export interface QueueContractOptions {
  /** Builds a queue whose jobs are executed by `runner`. */
  createQueue: (
    runner: (workflow: string, input: Record<string, unknown>) => Promise<WorkflowRun>,
  ) => Promise<JobQueue>;
  skip?: string | false;
  /** Redis-backed retries take seconds; in-memory ones are immediate. */
  retryTimeoutMs?: number;
}

export function makeRun(workflow: string, status: WorkflowRun["status"] = "succeeded"): WorkflowRun {
  return {
    runId: `run-${workflow}`,
    workflow,
    status,
    steps: [],
    results: {},
    startedAt: new Date().toISOString(),
    durationMs: 1,
  };
}

async function eventually(predicate: () => boolean, timeoutMs: number, describeFailure: () => string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out after ${timeoutMs}ms: ${describeFailure()}`);
}

export function runJobQueueContract(backendName: string, options: QueueContractOptions): void {
  const skip = (): { skip: string | boolean } => ({ skip: options.skip ?? false });
  const retryTimeout = options.retryTimeoutMs ?? 3_000;

  describe(`JobQueue contract: ${backendName}`, () => {
    test("executes an enqueued job with its input", skip(), async () => {
      const seen: { workflow: string; input: Record<string, unknown> }[] = [];
      const queue = await options.createQueue(async (workflow, input) => {
        seen.push({ workflow, input });
        return makeRun(workflow);
      });

      try {
        const jobId = await queue.enqueue("ingest", { text: "hello" });
        assert.ok(jobId, "enqueue must return a job id");

        await eventually(
          () => seen.length === 1,
          retryTimeout,
          () => `job never ran (${seen.length} runs)`,
        );
        assert.deepEqual(seen[0]?.input, { text: "hello" });
      } finally {
        await queue.close();
      }
    });

    test("honours a delay before running", skip(), async () => {
      let ranAt = 0;
      const queue = await options.createQueue(async (workflow) => {
        ranAt = Date.now();
        return makeRun(workflow);
      });

      try {
        const enqueuedAt = Date.now();
        await queue.enqueue("later", {}, { delayMs: 250 });

        await eventually(
          () => ranAt > 0,
          retryTimeout,
          () => "delayed job never ran",
        );
        assert.ok(ranAt - enqueuedAt >= 200, `job ran after ${ranAt - enqueuedAt}ms, expected at least ~250ms`);
      } finally {
        await queue.close();
      }
    });

    // The divergence this contract was written for.
    test("retries a failing job up to `attempts`", skip(), async () => {
      let calls = 0;
      const queue = await options.createQueue(async () => {
        calls += 1;
        throw new Error("transient");
      });

      try {
        await queue.enqueue("flaky", {}, { attempts: 3 });
        await eventually(
          () => calls >= 3,
          retryTimeout * 3,
          () => `saw ${calls} attempt(s), expected 3`,
        );
        assert.ok(calls >= 3, `expected at least 3 attempts, saw ${calls}`);
      } finally {
        await queue.close();
      }
    });

    test("stops retrying once attempts are exhausted", skip(), async () => {
      let calls = 0;
      const queue = await options.createQueue(async () => {
        calls += 1;
        throw new Error("always fails");
      });

      try {
        await queue.enqueue("doomed", {}, { attempts: 2 });
        await eventually(
          () => calls >= 2,
          retryTimeout * 3,
          () => `saw ${calls} attempt(s)`,
        );

        const settled = calls;
        await new Promise((resolve) => setTimeout(resolve, 600));
        assert.equal(calls, settled, `job kept retrying past its limit (${calls} attempts)`);
      } finally {
        await queue.close();
      }
    });

    /*
     * After close(), this instance must not invoke the runner again.
     *
     * What happens to the unstarted job differs by backend — the in-memory
     * queue drops it, a durable one leaves it in Redis for another worker —
     * but both must guarantee that no work starts *here* after teardown, when
     * the connections it needs are gone.
     */
    test("close() stops this instance running any further work", skip(), async () => {
      let ran = 0;
      const queue = await options.createQueue(async (workflow) => {
        ran += 1;
        return makeRun(workflow);
      });

      await queue.enqueue("after-close", {}, { delayMs: 400 });
      await queue.close();

      await new Promise((resolve) => setTimeout(resolve, 700));
      assert.equal(ran, 0, `a job ran ${ran} time(s) after the queue was closed`);
    });

    test("lists a repeating job with its schedule", skip(), async () => {
      const queue = await options.createQueue(async (workflow) => makeRun(workflow));

      try {
        await queue.schedule({
          id: "nightly",
          workflow: "cleanup",
          input: { deep: true },
          repeat: { every: 60_000 },
        });

        const jobs = await queue.list();
        const nightly = jobs.find((job) => job.id === "nightly");

        assert.ok(nightly, "a scheduled job must be listed");
        assert.equal(nightly.workflow, "cleanup");
        assert.deepEqual(nightly.input, { deep: true });
        assert.equal(nightly.repeat.every, 60_000);
      } finally {
        await queue.close();
      }
    });

    test("scheduling the same id replaces rather than duplicates", skip(), async () => {
      const queue = await options.createQueue(async (workflow) => makeRun(workflow));

      try {
        await queue.schedule({ id: "dup", workflow: "a", input: {}, repeat: { every: 60_000 } });
        await queue.schedule({ id: "dup", workflow: "b", input: {}, repeat: { every: 90_000 } });

        const matching = (await queue.list()).filter((job) => job.id === "dup");
        assert.equal(matching.length, 1);
        assert.equal(matching[0]?.workflow, "b");
      } finally {
        await queue.close();
      }
    });

    test("cancel removes a schedule and reports whether it existed", skip(), async () => {
      const queue = await options.createQueue(async (workflow) => makeRun(workflow));

      try {
        await queue.schedule({ id: "temp", workflow: "w", input: {}, repeat: { every: 60_000 } });

        assert.equal(await queue.cancel("temp"), true);
        assert.equal(await queue.cancel("temp"), false, "cancelling twice must report false");
        assert.equal(
          (await queue.list()).some((job) => job.id === "temp"),
          false,
        );
      } finally {
        await queue.close();
      }
    });

    test("a repeating schedule needs an interval or a cron expression", skip(), async () => {
      const queue = await options.createQueue(async (workflow) => makeRun(workflow));

      try {
        await assert.rejects(() => queue.schedule({ id: "bad", workflow: "w", input: {}, repeat: {} }));
      } finally {
        await queue.close();
      }
    });

    test("a workflow reporting failed is not a job failure", skip(), async () => {
      let calls = 0;
      const queue = await options.createQueue(async (workflow) => {
        calls += 1;
        // The engine ran and recorded the outcome. Retrying a deterministically
        // failing workflow would just burn the attempts for nothing.
        return makeRun(workflow, "failed");
      });

      try {
        await queue.enqueue("reports-failed", {}, { attempts: 3 });
        await eventually(
          () => calls >= 1,
          retryTimeout,
          () => "job never ran",
        );

        await new Promise((resolve) => setTimeout(resolve, 600));
        assert.equal(calls, 1, `a failed run triggered ${calls} attempts; it should not retry`);
      } finally {
        await queue.close();
      }
    });
  });
}
