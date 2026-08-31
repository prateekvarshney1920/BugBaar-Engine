import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { AgentDefinition } from "@bugbaar/agents";
import type { WorkflowRun } from "@bugbaar/workflows";
import { MongoMemoryServer } from "mongodb-memory-server";
import { runAgentRunStoreContract } from "@bugbaar/agents";
import { MongoAgentRunStore } from "./agent-runs.ts";
import { MongoAgentRepository } from "./agents.ts";
import { createPersistence, type PersistenceLayer } from "./bootstrap.ts";
import { MongoConnection } from "./connection.ts";
import { MongoMemoryStore } from "./memory.ts";
import { MongoWorkflowRunStore } from "./runs.ts";

/**
 * These run against a real mongod supplied by mongodb-memory-server, so the
 * queries, indexes, and driver behaviour under test are the production ones.
 *
 * Startup happens at module top level, matching the Redis and Qdrant suites:
 * node:test evaluates a test's options when the test is *registered*, which is
 * before any before() hook runs, so a flag set in a hook is always too late.
 */
let server: MongoMemoryServer | undefined;
let layer!: PersistenceLayer;
let uri = "";
let startupFailure: string | null = null;

try {
  server = await MongoMemoryServer.create();
  uri = server.getUri("bugbaar_test");
  layer = await createPersistence({ uri });
} catch (error) {
  startupFailure = error instanceof Error ? (error.stack ?? error.message) : String(error);
}

/*
 * An unavailable MongoDB is a failure here, not a skip — the opposite of the
 * Redis and Qdrant suites, and deliberately so.
 *
 * Those two talk to external service containers that a developer may
 * legitimately not be running, so skipping states the truth. MongoDB is
 * different: mongodb-memory-server downloads and runs its own mongod, needs no
 * service container, and is not configurable away. If it cannot start, the
 * environment is broken, and every one of these tests silently not running is
 * exactly the outcome worth preventing.
 *
 * Without this, the run still exits non-zero — node:test cancels the tests and
 * propagates that — but the summary reads "fail 0" with a bare "cancelled"
 * count and no reason, while the actual cause sits hundreds of lines up in the
 * TAP diagnostics. This turns that into a named failure that says what broke.
 */
if (startupFailure !== null) {
  // Registered first, so it is this named test that carries the failure into
  // the summary; the rest cancel behind it.
  test("MongoDB test infrastructure is available", () => {
    assert.equal(startupFailure, null);
  });
}

before(() => {
  if (startupFailure === null) return;

  // The explanation lives here rather than in the test body because a failing
  // before() hook pre-empts the body, so this is the message that is actually
  // shown. It is also re-thrown for every remaining test, which is why they
  // cancel against the real cause instead of a confusing error about an
  // undefined connection.
  throw new Error(
    [
      "MongoDB test infrastructure unavailable — the persistence suite did not run.",
      "",
      "These tests exercise real MongoDB behaviour (indexes, atomic operators, driver",
      "semantics) and are not meaningful against a mock, so they are never skipped.",
      "",
      "mongodb-memory-server manages its own mongod and needs no service container, so",
      "this usually means the binary could not be downloaded or does not match this",
      "platform.",
      "",
      `Cause: ${startupFailure}`,
    ].join("\n"),
  );
});

after(async () => {
  await layer?.close();
  await server?.stop();
});

describe("MongoMemoryStore", () => {
  test("round-trips messages in the order they were appended", async () => {
    await layer.memory.clear("s1");
    await layer.memory.append("s1", [
      { role: "user", content: "first" },
      { role: "assistant", content: "second" },
    ]);
    await layer.memory.append("s1", [{ role: "user", content: "third" }]);

    const history = await layer.memory.history("s1");

    assert.deepEqual(
      history.map((message) => message.content),
      ["first", "second", "third"],
    );
    assert.equal(history[0]?.role, "user");
    assert.ok(history[0]?.createdAt);
  });

  test("history(limit) returns the newest messages, still in order", async () => {
    await layer.memory.clear("s2");
    await layer.memory.append(
      "s2",
      Array.from({ length: 6 }, (_, index) => ({ role: "user" as const, content: `m${index}` })),
    );

    const history = await layer.memory.history("s2", 2);

    assert.deepEqual(
      history.map((message) => message.content),
      ["m4", "m5"],
    );
  });

  test("preserves tool calls and tool-call ids", async () => {
    await layer.memory.clear("s3");
    await layer.memory.append("s3", [
      {
        role: "assistant",
        content: "calling",
        toolCalls: [{ id: "call-1", name: "calculator", arguments: { a: 1, b: 2, operation: "add" } }],
      },
      { role: "tool", toolCallId: "call-1", content: "3" },
    ]);

    const [assistant, tool] = await layer.memory.history("s3");

    assert.equal(assistant?.toolCalls?.[0]?.name, "calculator");
    assert.deepEqual(assistant?.toolCalls?.[0]?.arguments, { a: 1, b: 2, operation: "add" });
    assert.equal(tool?.toolCallId, "call-1");
  });

  test("sessions are isolated from each other", async () => {
    await layer.memory.clear("a");
    await layer.memory.clear("b");
    await layer.memory.append("a", [{ role: "user", content: "for a" }]);
    await layer.memory.append("b", [{ role: "user", content: "for b" }]);

    assert.equal((await layer.memory.history("a")).length, 1);
    assert.equal((await layer.memory.history("b"))[0]?.content, "for b");

    await layer.memory.clear("a");
    assert.equal((await layer.memory.history("a")).length, 0);
    assert.equal((await layer.memory.history("b")).length, 1);
  });

  test("trims a session to its cap, dropping the oldest first", async () => {
    const store = new MongoMemoryStore(layer.connection.db(), {
      collectionName: "trim_test",
      maxMessagesPerSession: 4,
    });
    await store.ensureIndexes();

    await store.append(
      "capped",
      Array.from({ length: 7 }, (_, i) => ({ role: "user" as const, content: `m${i}` })),
    );

    const history = await store.history("capped");
    assert.equal(history.length, 4);
    assert.equal(history[0]?.content, "m3");
    assert.equal(history[3]?.content, "m6");
  });
});

describe("MongoAgentRepository", () => {
  const definition: AgentDefinition = {
    id: "researcher",
    name: "Research Assistant",
    goal: "Answer questions with citations.",
    tools: ["calculator"],
    maxSteps: 6,
    createdAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
  };

  test("saves and reads back a definition unchanged", async () => {
    await layer.agents.save(definition);
    const loaded = await layer.agents.get("researcher");

    assert.deepEqual(loaded, definition);
  });

  test("save is an upsert, not a duplicate", async () => {
    await layer.agents.save(definition);
    await layer.agents.save({ ...definition, goal: "Updated goal." });

    const all = (await layer.agents.list()).filter((entry) => entry.id === "researcher");
    assert.equal(all.length, 1);
    assert.equal(all[0]?.goal, "Updated goal.");
  });

  test("returns null for an unknown id and false when deleting one", async () => {
    assert.equal(await layer.agents.get("ghost"), null);
    assert.equal(await layer.agents.delete("ghost"), false);
  });

  test("delete removes the definition", async () => {
    await layer.agents.save({ ...definition, id: "temporary" });
    assert.equal(await layer.agents.delete("temporary"), true);
    assert.equal(await layer.agents.get("temporary"), null);
  });

  test("a definition survives a full reconnect — the point of the exercise", async () => {
    await new MongoAgentRepository(layer.connection.db(), "restart_test").save({ ...definition, id: "durable" });

    // A brand-new connection and repository stand in for a restarted process:
    // nothing is shared with the objects that wrote the data.
    const reconnected = await createPersistence({ uri });
    try {
      const fresh = new MongoAgentRepository(reconnected.connection.db(), "restart_test");
      const loaded = await fresh.get("durable");

      assert.equal(loaded?.id, "durable");
      assert.equal(loaded?.goal, definition.goal);
      assert.deepEqual(loaded?.tools, ["calculator"]);
    } finally {
      await reconnected.close();
    }
  });
});

describe("MongoWorkflowRunStore", () => {
  const run = (runId: string, status: WorkflowRun["status"] = "succeeded"): WorkflowRun => ({
    runId,
    workflow: "ingest-and-summarise",
    status,
    steps: [{ name: "ingest", status: "succeeded", attempts: 1, startedAt: new Date().toISOString(), durationMs: 3 }],
    results: { ingest: { chunks: 1 } },
    startedAt: new Date().toISOString(),
    durationMs: 5,
  });

  test("records a run and reads it back by id", async () => {
    await layer.runs.record(run("run-1"));
    const loaded = await layer.runs.get("run-1");

    assert.equal(loaded?.workflow, "ingest-and-summarise");
    assert.equal(loaded?.steps[0]?.name, "ingest");
  });

  test("keeps failed runs, with their error intact", async () => {
    await layer.runs.record({ ...run("run-failed", "failed"), error: 'Step "ingest" failed: no text' });
    const loaded = await layer.runs.get("run-failed");

    assert.equal(loaded?.status, "failed");
    assert.match(loaded?.error ?? "", /no text/);
  });

  test("recent() returns newest first and respects the limit", async () => {
    const store = new MongoWorkflowRunStore(layer.connection.db(), { collectionName: "recent_test" });
    await store.ensureIndexes();

    for (const id of ["r1", "r2", "r3"]) await store.record(run(id));

    const recent = await store.recent(2);
    assert.equal(recent.length, 2);
    assert.equal(recent[0]?.runId, "r3");
  });

  test("returns null for an unknown run id", async () => {
    assert.equal(await layer.runs.get("nope"), null);
  });
});

describe("MongoConnection", () => {
  test("ping reports liveness", async () => {
    assert.equal(await layer.connection.ping(), true);
  });

  test("db() throws before connect()", () => {
    const connection = new MongoConnection({ uri: "mongodb://127.0.0.1:1/none" });
    assert.throws(() => connection.db(), /not connected/);
  });

  test("gives up after maxAttempts against an unreachable server", async () => {
    const connection = new MongoConnection({
      uri: "mongodb://127.0.0.1:1/none",
      maxAttempts: 2,
      retryDelayMs: 10,
      connectTimeoutMs: 300,
    });

    await assert.rejects(() => connection.connect(), /Could not connect to MongoDB after 2 attempts/);
    assert.equal(connection.connected, false);
  });
});

describe("MongoMemoryStore concurrency", () => {
  /*
   * Regression test for a real race.
   *
   * Sequence numbers were assigned by reading the highest existing one and
   * adding one. Concurrent appends to the same session all read the same
   * value: ten simultaneous appends were measured landing on sequences
   * [0,0,0,0,0,0,0,0,1,1]. Every message survived, but history() sorts by
   * sequence, so the transcript came back in an arbitrary order.
   */
  test("concurrent appends get distinct, ordered sequence numbers", async () => {
    const store = new MongoMemoryStore(layer.connection.db(), { collectionName: "concurrent_messages" });
    await store.ensureIndexes();
    await store.clear("busy");

    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        store.append("busy", [{ role: "user" as const, content: `m${index}` }]),
      ),
    );

    const history = await store.history("busy");
    assert.equal(history.length, 20, "no message may be lost");

    const sequences = await layer.connection
      .db()
      .collection("concurrent_messages")
      .find({ sessionId: "busy" })
      .toArray();
    const values = sequences.map((document) => document.sequence as number);

    assert.equal(new Set(values).size, 20, `sequence numbers collided: ${JSON.stringify(values.sort())}`);
  });

  test("a multi-message append stays contiguous and in order", async () => {
    const store = new MongoMemoryStore(layer.connection.db(), { collectionName: "block_messages" });
    await store.ensureIndexes();
    await store.clear("block");

    // Interleave two three-message appends; neither may be split by the other.
    await Promise.all([
      store.append("block", [
        { role: "user", content: "a1" },
        { role: "assistant", content: "a2" },
        { role: "user", content: "a3" },
      ]),
      store.append("block", [
        { role: "user", content: "b1" },
        { role: "assistant", content: "b2" },
        { role: "user", content: "b3" },
      ]),
    ]);

    const contents = (await store.history("block")).map((message) => message.content);
    assert.equal(contents.length, 6);

    const aIndexes = ["a1", "a2", "a3"].map((c) => contents.indexOf(c));
    const bIndexes = ["b1", "b2", "b3"].map((c) => contents.indexOf(c));

    assert.deepEqual(aIndexes, [aIndexes[0]!, aIndexes[0]! + 1, aIndexes[0]! + 2], "block A was split apart");
    assert.deepEqual(bIndexes, [bIndexes[0]!, bIndexes[0]! + 1, bIndexes[0]! + 2], "block B was split apart");
  });

  test("clearing a session resets its counter", async () => {
    const store = new MongoMemoryStore(layer.connection.db(), { collectionName: "reset_messages" });
    await store.ensureIndexes();

    await store.append("reset", [{ role: "user", content: "first" }]);
    await store.clear("reset");
    await store.append("reset", [{ role: "user", content: "after clear" }]);

    const history = await store.history("reset");
    assert.equal(history.length, 1);
    assert.equal(history[0]?.content, "after clear");
  });
});

// The same contract the in-memory store satisfies, so the two cannot diverge.
let agentRunCollection = 0;
runAgentRunStoreContract("MongoAgentRunStore", {
  createStore: async () => {
    const store = new MongoAgentRunStore(layer.connection.db(), {
      collectionName: `agent_runs_contract_${++agentRunCollection}`,
    });
    await store.ensureIndexes();
    return store;
  },
});
