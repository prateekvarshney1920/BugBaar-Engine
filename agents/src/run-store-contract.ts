import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AgentRunStore } from "./runs.js";
import type { AgentRunResult } from "./types.js";

/**
 * The behaviour every AgentRunStore must exhibit, regardless of backend.
 *
 * The same pattern as the vector-store and job-queue contracts, and for the
 * same reason: two implementations of one interface that are each only tested
 * against themselves will drift, and the divergence shows up in production
 * rather than in CI.
 */

export interface AgentRunStoreContractOptions {
  /** Builds an empty store. Called once per test so cases stay isolated. */
  createStore: (testName: string) => Promise<AgentRunStore>;
  skip?: string | false;
}

export function makeResult(overrides: Partial<AgentRunResult> = {}): AgentRunResult {
  return {
    runId: "run-1",
    agentId: "assistant",
    output: "the answer",
    steps: [],
    messages: [],
    stoppedBecause: "completed",
    durationMs: 42,
    ...overrides,
  };
}

export function runAgentRunStoreContract(backendName: string, options: AgentRunStoreContractOptions): void {
  const skip = (): { skip: string | boolean } => ({ skip: options.skip ?? false });

  describe(`AgentRunStore contract: ${backendName}`, () => {
    test("a started run is retrievable and marked running", skip(), async () => {
      const store = await options.createStore("started");
      await store.start({ runId: "r1", agentId: "assistant", input: "hello", sessionId: "s1" });

      const record = await store.get("r1");

      assert.ok(record, "a started run must be retrievable");
      assert.equal(record.status, "running");
      assert.equal(record.agentId, "assistant");
      assert.equal(record.input, "hello");
      assert.equal(record.sessionId, "s1");
      assert.ok(record.startedAt, "startedAt must be recorded");
      assert.equal(record.output, undefined, "a running run has no output yet");
      assert.equal(record.finishedAt, undefined);
    });

    test("completing a run stores its outcome and duration", skip(), async () => {
      const store = await options.createStore("completed");
      await store.start({ runId: "r2", agentId: "assistant", input: "6 times 7?" });
      await store.complete(makeResult({ runId: "r2", output: "42", durationMs: 123 }));

      const record = await store.get("r2");

      assert.equal(record?.status, "completed");
      assert.equal(record?.stoppedBecause, "completed");
      assert.equal(record?.output, "42");
      assert.equal(record?.durationMs, 123);
      assert.ok(record?.finishedAt, "finishedAt must be set");
      // The input from start() must survive the completion patch.
      assert.equal(record?.input, "6 times 7?");
    });

    test("a failed run is distinguishable from a completed one", skip(), async () => {
      const store = await options.createStore("failed");
      await store.start({ runId: "ok", agentId: "assistant", input: "fine" });
      await store.complete(makeResult({ runId: "ok" }));

      await store.start({ runId: "bad", agentId: "assistant", input: "boom" });
      await store.fail("bad", "provider unreachable");

      const good = await store.get("ok");
      const bad = await store.get("bad");

      assert.equal(good?.status, "completed");
      assert.equal(good?.error, undefined);

      assert.equal(bad?.status, "failed");
      assert.equal(bad?.error, "provider unreachable");
      assert.ok(bad?.finishedAt, "a failed run still finished");
      // The input recorded at start must survive a failure too.
      assert.equal(bad?.input, "boom");
    });

    test("the trace preserves each step and its tool calls", skip(), async () => {
      const store = await options.createStore("trace");
      await store.start({ runId: "r3", agentId: "assistant", input: "multiply" });

      await store.complete(
        makeResult({
          runId: "r3",
          steps: [
            {
              index: 0,
              thought: "I need to multiply.",
              toolResults: [
                { callId: "c1", name: "calculator", ok: true, output: 42, durationMs: 3 },
                { callId: "c2", name: "http_request", ok: false, output: null, error: "blocked", durationMs: 7 },
              ],
            },
            { index: 1, thought: "The answer is 42.", toolResults: [] },
          ],
        }),
      );

      const record = await store.get("r3");

      assert.equal(record?.steps.length, 2);
      assert.equal(record?.steps[0]?.thought, "I need to multiply.");
      assert.equal(record?.steps[0]?.tools.length, 2);

      assert.deepEqual(record?.steps[0]?.tools[0], { name: "calculator", ok: true, durationMs: 3 });
      assert.equal(record?.steps[0]?.tools[1]?.ok, false);
      assert.equal(record?.steps[0]?.tools[1]?.error, "blocked");

      assert.equal(record?.steps[1]?.tools.length, 0);
    });

    test("the trace omits raw tool output, which lives in the transcript", skip(), async () => {
      const store = await options.createStore("no-output");
      await store.start({ runId: "r4", agentId: "assistant", input: "x" });
      await store.complete(
        makeResult({
          runId: "r4",
          steps: [
            {
              index: 0,
              thought: "t",
              toolResults: [
                { callId: "c", name: "calculator", ok: true, output: "SHOULD_NOT_BE_STORED", durationMs: 1 },
              ],
            },
          ],
        }),
      );

      const record = await store.get("r4");
      assert.equal(JSON.stringify(record).includes("SHOULD_NOT_BE_STORED"), false);
    });

    test("runs are kept separate and returned newest first", skip(), async () => {
      const store = await options.createStore("ordering");

      for (const [index, id] of ["a", "b", "c"].entries()) {
        await store.start({
          runId: id,
          agentId: "assistant",
          input: `input ${id}`,
          startedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
        });
        await store.complete(makeResult({ runId: id, output: `output ${id}` }));
      }

      const recent = await store.recent(10);

      assert.equal(recent.length, 3);
      assert.deepEqual(
        recent.map((run) => run.runId),
        ["c", "b", "a"],
        "recent() must return newest first",
      );
      assert.equal(recent[0]?.output, "output c", "records must not bleed into each other");
    });

    test("recent() respects its limit", skip(), async () => {
      const store = await options.createStore("limit");

      for (const [index, id] of ["a", "b", "c", "d"].entries()) {
        await store.start({
          runId: id,
          agentId: "assistant",
          input: id,
          startedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
        });
      }

      assert.equal((await store.recent(2)).length, 2);
      assert.equal((await store.recent(10)).length, 4);
    });

    test("recent() can be filtered to one agent", skip(), async () => {
      const store = await options.createStore("filter");
      await store.start({ runId: "x1", agentId: "alpha", input: "one" });
      await store.start({ runId: "x2", agentId: "beta", input: "two" });
      await store.start({ runId: "x3", agentId: "alpha", input: "three" });

      const alpha = await store.recent(10, { agentId: "alpha" });

      assert.equal(alpha.length, 2);
      assert.equal(
        alpha.every((run) => run.agentId === "alpha"),
        true,
      );
    });

    test("an unknown run id returns null rather than throwing", skip(), async () => {
      const store = await options.createStore("missing");
      assert.equal(await store.get("never-existed"), null);
    });

    test("failing an unknown run is a no-op, not an error", skip(), async () => {
      const store = await options.createStore("fail-missing");
      await store.fail("never-existed", "irrelevant");
      assert.equal(await store.get("never-existed"), null);
    });

    /*
     * If the write at start() fails, the finished run must still be visible.
     * Losing the record entirely would be worse than one with a blank input,
     * and it is exactly the case where someone is looking for the record.
     */
    test("completing a run that was never started still records it", skip(), async () => {
      const store = await options.createStore("orphan");
      await store.complete(makeResult({ runId: "orphan", agentId: "assistant", output: "recovered" }));

      const record = await store.get("orphan");

      assert.ok(record, "an unstarted run must still be recorded on completion");
      assert.equal(record.status, "completed");
      assert.equal(record.output, "recovered");
      assert.equal(record.agentId, "assistant");
    });

    test("an empty store returns an empty list", skip(), async () => {
      const store = await options.createStore("empty");
      assert.deepEqual(await store.recent(10), []);
    });
  });
}
