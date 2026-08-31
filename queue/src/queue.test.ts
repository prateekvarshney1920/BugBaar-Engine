import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import type { WorkflowRun } from "@bugbaar/workflows";
import { Redis } from "ioredis";
import { runJobQueueContract } from "@bugbaar/workflows";
import { BullJobQueue } from "./bull-queue.ts";
import { createRedisClient, pingRedis, toRedisOptions, waitForRedis } from "./connection.ts";
import { RedisRateLimiter } from "./rate-limit.ts";
import { createWorkflowWorker } from "./worker.ts";

/**
 * Integration tests against a real Redis.
 *
 * Set REDIS_TEST_URL to point at one; without it the suite skips rather than
 * failing, so `npm test` still works on a machine with no Redis.
 */
const REDIS_URL = process.env.REDIS_TEST_URL ?? "redis://127.0.0.1:6399";
const redisOptions = toRedisOptions(REDIS_URL);

/*
 * Connecting at module top level, not in before(): node:test evaluates a
 * test's options when the test is *registered*, which happens before any
 * before() hook runs. Setting the flag in before() left every test skipped
 * while the suite still reported success — silence that looks like passing.
 */
let available = false;
let connection!: Redis;

try {
  connection = createRedisClient({ url: REDIS_URL });
  await waitForRedis(connection, 3_000);
  await connection.flushdb();
  available = true;
} catch {
  connection?.disconnect();
}

after(async () => {
  if (available) {
    await connection.flushdb();
    connection.disconnect();
  }
});

const skip = (): { skip: string | boolean } => ({
  skip: available ? false : `no Redis at ${REDIS_URL} (set REDIS_TEST_URL)`,
});

function makeRun(workflow: string, status: WorkflowRun["status"] = "succeeded"): WorkflowRun {
  return {
    runId: `run-${workflow}-${status}`,
    workflow,
    status,
    steps: [],
    results: {},
    startedAt: new Date().toISOString(),
    durationMs: 1,
  };
}

/** Waits for `predicate` to hold, polling — queue work is inherently async. */
async function eventually(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}

// The same contract the in-memory queue satisfies. Each contract case gets its
// own queue name and worker so the cases cannot interfere.
let contractQueue = 0;
runJobQueueContract("BullJobQueue", {
  skip: available ? false : `no Redis at ${REDIS_URL} (set REDIS_TEST_URL)`,
  retryTimeoutMs: 6_000,
  createQueue: async (runner) => {
    const queueName = `contract-${++contractQueue}`;
    const worker = createWorkflowWorker({ connection: redisOptions, queueName, runner });
    const queue = new BullJobQueue({ connection: redisOptions, queueName, defaultAttempts: 1 });

    return {
      durable: queue.durable,
      enqueue: (workflow, input, options) => queue.enqueue(workflow, input, options),
      schedule: (job) => queue.schedule(job),
      cancel: (id) => queue.cancel(id),
      list: () => queue.list(),
      async close() {
        await worker.close();
        await queue.close();
      },
    };
  },
});

describe("BullJobQueue + worker", () => {
  test("an enqueued job is executed by the worker", skip(), async () => {
    const executed: { workflow: string; input: Record<string, unknown> }[] = [];

    const queue = new BullJobQueue({ connection: redisOptions, queueName: "test-execute" });
    const worker = createWorkflowWorker({
      connection: redisOptions,
      queueName: "test-execute",
      runner: async (workflow, input) => {
        executed.push({ workflow, input });
        return makeRun(workflow);
      },
    });

    try {
      const jobId = await queue.enqueue("ingest", { text: "hello" });
      assert.ok(jobId);

      await eventually(() => executed.length === 1);
      assert.equal(executed[0]?.workflow, "ingest");
      assert.deepEqual(executed[0]?.input, { text: "hello" });
    } finally {
      await worker.close();
      await queue.close();
    }
  });

  test("a job survives being enqueued before any worker exists", skip(), async () => {
    const queue = new BullJobQueue({ connection: redisOptions, queueName: "test-durable" });
    await queue.enqueue("later", { n: 1 }, { jobId: "durable-job" });
    await queue.close();

    // A worker starting afterwards — a restarted process — still picks it up.
    const executed: string[] = [];
    const worker = createWorkflowWorker({
      connection: redisOptions,
      queueName: "test-durable",
      runner: async (workflow) => {
        executed.push(workflow);
        return makeRun(workflow);
      },
    });

    try {
      await eventually(() => executed.includes("later"));
    } finally {
      await worker.close();
    }
  });

  test("a workflow that reports failed does not trigger a job retry", skip(), async () => {
    let attempts = 0;

    const queue = new BullJobQueue({ connection: redisOptions, queueName: "test-failedrun" });
    const worker = createWorkflowWorker({
      connection: redisOptions,
      queueName: "test-failedrun",
      runner: async (workflow) => {
        attempts += 1;
        return makeRun(workflow, "failed");
      },
    });

    try {
      await queue.enqueue("bad", {}, { attempts: 3 });
      await eventually(() => attempts === 1);

      // Give BullMQ room to retry if it were going to; it must not.
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      assert.equal(attempts, 1);
    } finally {
      await worker.close();
      await queue.close();
    }
  });

  test("an unknown workflow is retried, because that is infrastructure failure", skip(), async () => {
    let attempts = 0;

    const queue = new BullJobQueue({ connection: redisOptions, queueName: "test-retry" });
    const worker = createWorkflowWorker({
      connection: redisOptions,
      queueName: "test-retry",
      runner: async (workflow) => {
        attempts += 1;
        throw new Error(`Unknown workflow "${workflow}"`);
      },
    });

    try {
      await queue.enqueue("ghost", {}, { attempts: 2 });
      await eventually(() => attempts >= 2, 12_000);
      assert.ok(attempts >= 2, `expected a retry, saw ${attempts} attempt(s)`);
    } finally {
      await worker.close();
      await queue.close();
    }
  });

  test("repeating jobs are listed and can be cancelled", skip(), async () => {
    const queue = new BullJobQueue({ connection: redisOptions, queueName: "test-repeat" });

    try {
      await queue.schedule({ id: "nightly", workflow: "cleanup", input: { deep: true }, repeat: { every: 60_000 } });

      const jobs = await queue.list();
      const nightly = jobs.find((job) => job.id === "nightly");

      assert.ok(nightly, "scheduled job should be listed");
      assert.equal(nightly.workflow, "cleanup");
      assert.deepEqual(nightly.input, { deep: true });
      assert.equal(nightly.repeat.every, 60_000);
      assert.ok(nightly.nextRunAt);

      assert.equal(await queue.cancel("nightly"), true);
      assert.equal(
        (await queue.list()).some((job) => job.id === "nightly"),
        false,
      );
    } finally {
      await queue.close();
    }
  });

  test("scheduling the same id twice replaces rather than duplicates", skip(), async () => {
    const queue = new BullJobQueue({ connection: redisOptions, queueName: "test-replace" });

    try {
      await queue.schedule({ id: "dup", workflow: "a", input: {}, repeat: { every: 60_000 } });
      await queue.schedule({ id: "dup", workflow: "b", input: {}, repeat: { every: 120_000 } });

      const matching = (await queue.list()).filter((job) => job.id === "dup");
      assert.equal(matching.length, 1);
      assert.equal(matching[0]?.workflow, "b");
    } finally {
      await queue.close();
    }
  });

  test("cancelling an unknown job reports false", skip(), async () => {
    const queue = new BullJobQueue({ connection: redisOptions, queueName: "test-cancel" });
    try {
      assert.equal(await queue.cancel("never-existed"), false);
    } finally {
      await queue.close();
    }
  });

  test("a schedule with neither every nor cron is rejected", skip(), async () => {
    const queue = new BullJobQueue({ connection: redisOptions, queueName: "test-invalid" });
    try {
      await assert.rejects(
        () => queue.schedule({ id: "bad", workflow: "x", input: {}, repeat: {} }),
        /needs repeat.every or repeat.cron/,
      );
    } finally {
      await queue.close();
    }
  });
});

describe("RedisRateLimiter", () => {
  test("allows up to the limit, then refuses", skip(), async () => {
    const limiter = new RedisRateLimiter({
      connection,
      windowMs: 10_000,
      max: 3,
      keyPrefix: "test:rl:basic:",
    });

    const decisions = [];
    for (let i = 0; i < 5; i += 1) decisions.push(await limiter.consume("client"));

    assert.deepEqual(
      decisions.map((decision) => decision.allowed),
      [true, true, true, false, false],
    );
    assert.equal(decisions[0]?.remaining, 2);
    assert.equal(decisions[2]?.remaining, 0);
    assert.ok((decisions[3]?.retryAfterSeconds ?? 0) > 0);
  });

  test("counts are shared across limiter instances — the point of using Redis", skip(), async () => {
    const options = { connection, windowMs: 10_000, max: 2, keyPrefix: "test:rl:shared:" };

    // Two instances stand in for two replicas behind a load balancer.
    const replicaA = new RedisRateLimiter(options);
    const replicaB = new RedisRateLimiter(options);

    assert.equal((await replicaA.consume("same-key")).allowed, true);
    assert.equal((await replicaB.consume("same-key")).allowed, true);

    // The third request is refused no matter which replica receives it.
    assert.equal((await replicaA.consume("same-key")).allowed, false);
    assert.equal((await replicaB.consume("same-key")).allowed, false);
  });

  test("different keys are counted separately", skip(), async () => {
    const limiter = new RedisRateLimiter({ connection, windowMs: 10_000, max: 1, keyPrefix: "test:rl:keys:" });

    assert.equal((await limiter.consume("alice")).allowed, true);
    assert.equal((await limiter.consume("bob")).allowed, true);
    assert.equal((await limiter.consume("alice")).allowed, false);
  });

  test("the window expires and the budget returns", skip(), async () => {
    const limiter = new RedisRateLimiter({ connection, windowMs: 600, max: 1, keyPrefix: "test:rl:expiry:" });

    assert.equal((await limiter.consume("ticker")).allowed, true);
    assert.equal((await limiter.consume("ticker")).allowed, false);

    await new Promise((resolve) => setTimeout(resolve, 900));
    assert.equal((await limiter.consume("ticker")).allowed, true);
  });

  test("reports itself as shared", skip(), async () => {
    const limiter = new RedisRateLimiter({ connection, windowMs: 1_000, max: 1 });
    assert.equal(limiter.shared, true);
  });
});

describe("connection helpers", () => {
  test("ping succeeds against a live server", skip(), async () => {
    assert.equal(await pingRedis(connection), true);
  });

  test("waitForRedis rejects for an unreachable server", async () => {
    const dead = new Redis("redis://127.0.0.1:1", { lazyConnect: true, retryStrategy: () => null });
    dead.connect().catch(() => undefined);

    await assert.rejects(() => waitForRedis(dead, 1_000));
    dead.disconnect();
  });
});
