import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { AgentSummary, ErrorBody, HealthResponse, RunAgentResponse, SearchResponse } from "@bugbaar/api";
import { createHarness, post, type TestHarness } from "./testing.ts";

/**
 * End-to-end tests over real HTTP against the real app.
 *
 * These replace what scripts/smoke-test.sh could only check against a
 * manually-started server, so the gateway's behaviour is now covered in CI.
 */
let h: TestHarness;

before(async () => {
  h = await createHarness();
});

after(async () => {
  await h?.close();
});

describe("health", () => {
  test("reports status and which dependencies are configured", async () => {
    const { status, body } = await h.json<HealthResponse>("/health");

    assert.equal(status, 200);
    assert.equal(body.status, "ok");
    // Nothing external is configured in the harness, so every backing service
    // should say so rather than claiming to be up.
    assert.equal(body.dependencies.mongodb, "not_configured");
    assert.equal(body.dependencies.redis, "not_configured");
  });

  test("liveness and readiness are reachable without an API key", async () => {
    assert.equal((await h.request("/health/live", { apiKey: null })).status, 200);
    assert.equal((await h.request("/health/ready", { apiKey: null })).status, 200);
  });
});

describe("gateway", () => {
  test("rejects a request with no API key", async () => {
    const { status, body } = await h.json<ErrorBody>("/v1/agents", { apiKey: null });

    assert.equal(status, 401);
    assert.equal(body.error.code, "unauthorized");
    assert.ok(body.requestId, "every error must carry a request id");
  });

  test("rejects a wrong API key", async () => {
    assert.equal((await h.request("/v1/agents", { apiKey: "wrong" })).status, 401);
  });

  test("echoes a caller-supplied request id so logs can be correlated", async () => {
    const response = await h.request("/health", { headers: { "x-request-id": "trace-me" } });
    assert.equal(response.headers.get("x-request-id"), "trace-me");
  });

  test("sets security headers and hides the framework", async () => {
    const response = await h.request("/health");

    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.equal(response.headers.get("x-powered-by"), null);
  });

  test("reports rate-limit headers, including whether the limit is shared", async () => {
    const response = await h.request("/v1/agents");

    assert.ok(response.headers.get("x-ratelimit-limit"));
    // Without Redis the limit is per-process, and callers need to know that.
    assert.equal(response.headers.get("x-ratelimit-scope"), "local");
  });

  test("an unknown route returns the standard error envelope", async () => {
    const { status, body } = await h.json<ErrorBody>("/v1/nope");

    assert.equal(status, 404);
    assert.equal(body.error.code, "not_found");
  });

  test("malformed JSON is a 400, not a crash", async () => {
    const response = await h.request("/v1/agents", {
      method: "POST",
      body: "{not json",
      headers: { "content-type": "application/json" },
    });

    assert.equal(response.status, 400);
  });
});

describe("agents", () => {
  test("creates, fetches, lists, and deletes an agent", async () => {
    const created = await h.json<AgentSummary>(
      "/v1/agents",
      post({ id: "crud", goal: "test", tools: ["calculator"] }),
    );
    assert.equal(created.status, 201);
    assert.equal(created.body.id, "crud");
    assert.deepEqual(created.body.tools, ["calculator"]);

    const fetched = await h.json<AgentSummary>("/v1/agents/crud");
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.createdAt, created.body.createdAt);

    const listed = await h.json<{ agents: AgentSummary[] }>("/v1/agents");
    assert.ok(listed.body.agents.some((agent) => agent.id === "crud"));

    assert.equal((await h.request("/v1/agents/crud", { method: "DELETE" })).status, 204);
    assert.equal((await h.request("/v1/agents/crud")).status, 404);
  });

  test("rejects a duplicate id", async () => {
    await h.json("/v1/agents", post({ id: "dupe" }));
    const { status, body } = await h.json<ErrorBody>("/v1/agents", post({ id: "dupe" }));

    assert.equal(status, 409);
    assert.equal(body.error.code, "agent_exists");
  });

  /*
   * Regression test for a real race.
   *
   * Creation used to be "get(id), then save(id)". Concurrent requests for the
   * same id all passed the existence check and all saved, so the last write
   * silently won and several callers got a 201 for one agent. Creation is now
   * a single atomic insert.
   */
  test("concurrent creates with the same id produce exactly one agent", async () => {
    const attempts = await Promise.all(
      Array.from({ length: 12 }, () => h.request("/v1/agents", post({ id: "racer", goal: "one winner only" }))),
    );

    const created = attempts.filter((response) => response.status === 201);
    const conflicted = attempts.filter((response) => response.status === 409);

    assert.equal(created.length, 1, "exactly one request may create the agent");
    assert.equal(conflicted.length, 11, "every other request must see a conflict");

    const listed = await h.json<{ agents: AgentSummary[] }>("/v1/agents");
    assert.equal(listed.body.agents.filter((agent) => agent.id === "racer").length, 1);
  });

  test("rejects an unknown tool and says which tools exist", async () => {
    const { status, body } = await h.json<ErrorBody>("/v1/agents", post({ id: "bad-tool", tools: ["nope"] }));

    assert.equal(status, 400);
    assert.match(body.error.message, /Unknown tool/);
    assert.ok(Array.isArray((body.error.details as { available?: unknown[] })?.available));
  });

  test("a rejected agent is never persisted", async () => {
    await h.json("/v1/agents", post({ id: "ghost-agent", tools: ["nope"] }));

    // The failed create must leave nothing behind for a later restart to restore.
    assert.equal(await h.container.agentRepository.get("ghost-agent"), null);
    assert.equal((await h.request("/v1/agents/ghost-agent")).status, 404);
  });

  test("validates the id format", async () => {
    for (const id of ["-leading-dash", "has space", "has/slash", ""]) {
      const response = await h.request("/v1/agents", post({ id }));
      assert.equal(response.status, 400, `id ${JSON.stringify(id)} should be rejected`);
    }
  });

  test("rejects out-of-range maxSteps and non-string tools", async () => {
    assert.equal((await h.request("/v1/agents", post({ id: "a1", maxSteps: 0 }))).status, 400);
    assert.equal((await h.request("/v1/agents", post({ id: "a2", maxSteps: 999 }))).status, 400);
    assert.equal((await h.request("/v1/agents", post({ id: "a3", tools: [7] }))).status, 400);
  });

  test("runs an agent and returns its transcript", async () => {
    const { status, body } = await h.json<RunAgentResponse>(
      "/v1/agents/assistant/run",
      post({ input: "hello there", sessionId: "run-test" }),
    );

    assert.equal(status, 200);
    assert.equal(body.agentId, "assistant");
    assert.equal(body.stoppedBecause, "completed");
    assert.match(body.output, /hello there/);
    assert.ok(body.runId);
  });

  test("rejects an empty or missing input", async () => {
    assert.equal((await h.request("/v1/agents/assistant/run", post({ input: "" }))).status, 400);
    assert.equal((await h.request("/v1/agents/assistant/run", post({}))).status, 400);
  });

  test("running an unknown agent is a 404", async () => {
    assert.equal((await h.request("/v1/agents/ghost/run", post({ input: "hi" }))).status, 404);
  });

  test("memory is written by a run, readable, and clearable per session", async () => {
    await h.json("/v1/agents/assistant/run", post({ input: "remember me", sessionId: "mem-test" }));

    const read = await h.json<{ messages: { content: string }[] }>("/v1/agents/assistant/memory?sessionId=mem-test");
    assert.equal(read.status, 200);
    assert.ok(read.body.messages.some((message) => message.content === "remember me"));

    assert.equal(
      (await h.request("/v1/agents/assistant/memory?sessionId=mem-test", { method: "DELETE" })).status,
      204,
    );

    const after = await h.json<{ messages: unknown[] }>("/v1/agents/assistant/memory?sessionId=mem-test");
    assert.equal(after.body.messages.length, 0);
  });

  test("sessions do not leak into each other", async () => {
    await h.json("/v1/agents/assistant/run", post({ input: "for alice", sessionId: "alice" }));
    await h.json("/v1/agents/assistant/run", post({ input: "for bob", sessionId: "bob" }));

    const alice = await h.json<{ messages: { content: string }[] }>("/v1/agents/assistant/memory?sessionId=alice");
    assert.equal(
      alice.body.messages.some((message) => message.content === "for bob"),
      false,
    );
  });

  test("lists the tool catalogue with schemas", async () => {
    const { body } = await h.json<{ tools: { name: string; parameters: unknown }[] }>("/v1/tools");

    const calculator = body.tools.find((tool) => tool.name === "calculator");
    assert.ok(calculator, "the calculator tool should be registered");
    assert.ok(calculator.parameters, "each tool must publish its JSON schema");
  });
});

describe("knowledge", () => {
  test("ingests, searches, counts, and deletes documents", async () => {
    const ingested = await h.json<{ documents: number; chunks: number }>(
      "/v1/knowledge/documents",
      post({ documents: [{ id: "kb-1", text: "Qdrant stores vector embeddings for semantic search." }] }),
    );
    assert.equal(ingested.status, 201);
    assert.equal(ingested.body.chunks, 1);

    const search = await h.json<SearchResponse>(
      "/v1/knowledge/search",
      post({ query: "vector embeddings semantic search", topK: 3 }),
    );
    assert.equal(search.status, 200);
    assert.equal(search.body.hits[0]?.documentId, "kb-1");

    assert.equal((await h.request("/v1/knowledge/documents/kb-1", { method: "DELETE" })).status, 204);

    const stats = await h.json<{ chunks: number }>("/v1/knowledge/stats");
    assert.equal(stats.body.chunks, 0);
  });

  test("re-ingesting an id replaces its chunks rather than duplicating them", async () => {
    const body = (text: string) => post({ documents: [{ id: "dup-doc", text }] });

    await h.json("/v1/knowledge/documents", body("first revision of the document"));
    await h.json("/v1/knowledge/documents", body("second revision of the document"));

    const stats = await h.json<{ chunks: number }>("/v1/knowledge/stats");
    assert.equal(stats.body.chunks, 1);

    await h.request("/v1/knowledge/documents/dup-doc", { method: "DELETE" });
  });

  test("rejects malformed ingest payloads", async () => {
    assert.equal((await h.request("/v1/knowledge/documents", post({ documents: [] }))).status, 400);
    assert.equal((await h.request("/v1/knowledge/documents", post({ documents: [{ id: "x" }] }))).status, 400);
    assert.equal((await h.request("/v1/knowledge/documents", post({}))).status, 400);
  });

  test("rejects an out-of-range topK", async () => {
    assert.equal((await h.request("/v1/knowledge/search", post({ query: "x", topK: 0 }))).status, 400);
    assert.equal((await h.request("/v1/knowledge/search", post({ query: "x", topK: 500 }))).status, 400);
  });

  test("ask against an unknown agent is rejected", async () => {
    const response = await h.request("/v1/knowledge/ask", post({ query: "anything", agentId: "ghost" }));
    assert.equal(response.status, 400);
  });
});

describe("workflows", () => {
  test("lists registered workflows with their steps", async () => {
    const { body } = await h.json<{ workflows: { name: string; steps: { name: string }[] }[] }>("/v1/workflows");

    const workflow = body.workflows.find((entry) => entry.name === "ingest-and-summarise");
    assert.ok(workflow);
    assert.deepEqual(
      workflow.steps.map((step) => step.name),
      ["ingest", "summarise", "notify"],
    );
  });

  test("a successful run returns 200 with a full record", async () => {
    const { status, body } = await h.json<{ status: string; steps: { name: string; status: string }[] }>(
      "/v1/workflows/ingest-and-summarise/run",
      post({ input: { id: "wf-ok", text: "Workflows orchestrate steps." } }),
    );

    assert.equal(status, 200);
    assert.equal(body.status, "succeeded");
    assert.equal(body.steps.length, 3);
  });

  /*
   * A failed workflow is a completed request, not a server error: the engine
   * ran and recorded the outcome. It returns 422 with the same record shape so
   * a caller can see which step failed and how often it retried.
   */
  test("a failed run returns 422 and still records every step", async () => {
    const { status, body } = await h.json<{
      status: string;
      error?: string;
      steps: { name: string; status: string; attempts: number }[];
    }>("/v1/workflows/ingest-and-summarise/run", post({ input: {} }));

    assert.equal(status, 422);
    assert.equal(body.status, "failed");
    assert.match(body.error ?? "", /requires a "text" field/);

    const byName = Object.fromEntries(body.steps.map((step) => [step.name, step]));
    assert.equal(byName.ingest?.status, "failed");
    assert.ok((byName.ingest?.attempts ?? 0) > 1, "the failing step should have retried");
    assert.equal(byName.summarise?.status, "skipped", "a failure stops later steps");
    assert.equal(byName.notify?.status, "succeeded", "alwaysRun steps still execute");
  });

  test("run history records both outcomes and is fetchable by id", async () => {
    const { body } = await h.json<{ runs: { runId: string; status: string }[] }>("/v1/workflows/runs?limit=10");

    assert.ok(body.runs.length >= 2);
    assert.ok(body.runs.some((run) => run.status === "succeeded"));
    assert.ok(body.runs.some((run) => run.status === "failed"));

    const one = await h.json<{ runId: string }>(`/v1/workflows/runs/${body.runs[0]!.runId}`);
    assert.equal(one.status, 200);
    assert.equal(one.body.runId, body.runs[0]!.runId);
  });

  test("an unknown run id is a 404", async () => {
    assert.equal((await h.request("/v1/workflows/runs/does-not-exist")).status, 404);
  });

  test("enqueue returns 202 and reports that the queue is not durable", async () => {
    const { status, body } = await h.json<{ jobId: string; durable: boolean }>(
      "/v1/workflows/ingest-and-summarise/enqueue",
      post({ input: { id: "wf-q", text: "queued" } }),
    );

    assert.equal(status, 202);
    assert.ok(body.jobId);
    // Without Redis the job lives on a timer; callers must be able to tell.
    assert.equal(body.durable, false);
  });

  test("enqueueing an unknown workflow is a 404, not an accepted job", async () => {
    assert.equal((await h.request("/v1/workflows/ghost/enqueue", post({ input: {} }))).status, 404);
  });

  test("schedules can be created, listed, and cancelled", async () => {
    const created = await h.json<{ id: string }>(
      "/v1/schedules",
      post({ id: "sched-1", workflow: "ingest-and-summarise", every: 60_000, input: { text: "tick" } }),
    );
    assert.equal(created.status, 201);

    const listed = await h.json<{ jobs: { id: string; workflow: string }[] }>("/v1/schedules");
    assert.ok(listed.body.jobs.some((job) => job.id === "sched-1"));

    assert.equal((await h.request("/v1/schedules/sched-1", { method: "DELETE" })).status, 204);
    assert.equal((await h.request("/v1/schedules/sched-1", { method: "DELETE" })).status, 404);
  });

  test("a schedule needs an interval or a cron expression", async () => {
    const response = await h.request("/v1/schedules", post({ id: "no-when", workflow: "ingest-and-summarise" }));
    assert.equal(response.status, 400);
  });

  test("a schedule for an unknown workflow is rejected", async () => {
    const response = await h.request("/v1/schedules", post({ id: "bad-wf", workflow: "ghost", every: 60_000 }));
    assert.equal(response.status, 404);
  });
});

describe("rate limiting", () => {
  test("refuses requests past the limit and says when to retry", async () => {
    const limited = await createHarness({ env: { RATE_LIMIT_MAX: "5", RATE_LIMIT_WINDOW_MS: "60000" }, seed: false });

    try {
      const codes: number[] = [];
      for (let i = 0; i < 8; i += 1) {
        codes.push((await limited.request("/v1/agents")).status);
      }

      assert.equal(codes.filter((code) => code === 200).length, 5);
      assert.equal(codes.filter((code) => code === 429).length, 3);

      const refused = await limited.request("/v1/agents");
      assert.ok(refused.headers.get("retry-after"), "a 429 must tell the caller when to retry");
    } finally {
      await limited.close();
    }
  });

  test("health checks are not rate limited, so probes cannot mark the app down", async () => {
    const limited = await createHarness({ env: { RATE_LIMIT_MAX: "2", RATE_LIMIT_WINDOW_MS: "60000" }, seed: false });

    try {
      for (let i = 0; i < 6; i += 1) {
        assert.equal((await limited.request("/health/live", { apiKey: null })).status, 200);
      }
    } finally {
      await limited.close();
    }
  });
});

describe("configuration", () => {
  test("production refuses to boot without API keys", async () => {
    await assert.rejects(
      () => createHarness({ env: { NODE_ENV: "production", API_KEYS: "" } }),
      /API_KEYS must be set in production/,
    );
  });

  test("SEED_EXAMPLES=false leaves a deleted example deleted", async () => {
    const unseeded = await createHarness({ env: { SEED_EXAMPLES: "false" } });

    try {
      assert.equal((await unseeded.request("/v1/agents/assistant")).status, 404);
    } finally {
      await unseeded.close();
    }
  });
});

describe("streaming", () => {
  /** Reads an SSE body into `event: name` / parsed-data pairs. */
  async function readEvents(response: Response): Promise<{ event: string; data: Record<string, unknown> }[]> {
    const text = await response.text();
    const frames: { event: string; data: Record<string, unknown> }[] = [];

    for (const block of text.split("\n\n")) {
      const event = /^event: (.+)$/m.exec(block)?.[1];
      const data = /^data: (.+)$/m.exec(block)?.[1];
      if (event && data) frames.push({ event, data: JSON.parse(data) as Record<string, unknown> });
    }

    return frames;
  }

  test("streams a run as server-sent events", async () => {
    const response = await h.request("/v1/agents/assistant/run/stream", post({ input: "stream this please" }));

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    // nginx would otherwise buffer the whole stream and defeat the point.
    assert.equal(response.headers.get("x-accel-buffering"), "no");

    const frames = await readEvents(response);
    const names = frames.map((frame) => frame.event);

    assert.equal(names[0], "run-start");
    assert.equal(names.at(-1), "run-end");
    assert.ok(names.includes("token"));
  });

  test("token events concatenate to the final output", async () => {
    const response = await h.request("/v1/agents/assistant/run/stream", post({ input: "the quick brown fox" }));
    const frames = await readEvents(response);

    const streamed = frames
      .filter((frame) => frame.event === "token")
      .map((frame) => frame.data.text as string)
      .join("");

    const end = frames.find((frame) => frame.event === "run-end");
    const result = end?.data.result as { output: string };

    assert.equal(streamed, result.output);
    assert.match(streamed, /the quick brown fox/);
  });

  test("a streamed run writes to memory like a normal run", async () => {
    await h.request(
      "/v1/agents/assistant/run/stream",
      post({ input: "remember streaming", sessionId: "stream-mem" }),
    );

    const memory = await h.json<{ messages: { content: string }[] }>(
      "/v1/agents/assistant/memory?sessionId=stream-mem",
    );
    assert.ok(memory.body.messages.some((message) => message.content === "remember streaming"));
  });

  test("streaming an unknown agent is a 404 before the stream opens", async () => {
    const response = await h.request("/v1/agents/ghost/run/stream", post({ input: "hi" }));

    assert.equal(response.status, 404);
    assert.match(response.headers.get("content-type") ?? "", /application\/json/);
  });

  test("validates input before committing to a 200", async () => {
    // Once headers are sent the status is fixed, so validation has to happen
    // first or a bad request would be reported as a successful stream.
    assert.equal((await h.request("/v1/agents/assistant/run/stream", post({ input: "" }))).status, 400);
  });

  test("requires an API key", async () => {
    const response = await h.request("/v1/agents/assistant/run/stream", {
      ...post({ input: "hi" }),
      apiKey: null,
    });
    assert.equal(response.status, 401);
  });

  test("hanging up mid-stream ends the run instead of finishing it", async () => {
    // Pace the synthetic stream so there is a middle to hang up in.
    const slow = await createHarness({ env: { ECHO_CHUNK_DELAY_MS: "40" } });

    try {
      const controller = new AbortController();

      // fetch resolves once headers arrive, so the abort has to happen while
      // the body is still being read — that is what a browser tab closing does.
      const response = await fetch(`${slow.baseUrl}/v1/agents/assistant/run/stream`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "test-key" },
        body: JSON.stringify({ input: "one two three four five six seven eight nine ten" }),
        signal: controller.signal,
      });

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let received = "";

      // Read until tokens are flowing, then hang up.
      while (!received.includes("event: token")) {
        const { value, done } = await reader.read();
        if (done) break;
        received += decoder.decode(value, { stream: true });
      }

      controller.abort();

      await assert.rejects(() => reader.read(), /abort/i);

      // The decisive assertion: the run never reached its end, so the server
      // stopped working rather than carrying on for a client that had gone.
      assert.ok(received.includes("event: token"), "tokens should have started");
      assert.equal(received.includes("event: run-end"), false, "the run must not have completed");
    } finally {
      await slow.close();
    }
  });
});

describe("shutdown", () => {
  /*
   * Regression test for a real outage-shaped bug.
   *
   * server.close() stops accepting connections and waits for the open ones to
   * finish. An SSE stream never finishes on its own, so shutdown hung until
   * the watchdog fired process.exit(1) — every deploy with an active stream
   * looked like a crash to an orchestrator, and killed in-flight work.
   */
  test("an open stream does not block shutdown", async () => {
    const streaming = await createHarness({ env: { ECHO_CHUNK_DELAY_MS: "500" } });

    const response = await fetch(`${streaming.baseUrl}/v1/agents/assistant/run/stream`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "test-key" },
      body: JSON.stringify({ input: "a b c d e f g h i j k l m n" }),
    });

    const reader = response.body!.getReader();
    await reader.read();

    assert.equal(streaming.container.streams.size, 1, "the open stream should be registered");

    const started = Date.now();
    const outcome = await Promise.race([
      streaming.close().then(() => "closed" as const),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 4_000)),
    ]);

    assert.equal(outcome, "closed", `shutdown did not complete (${Date.now() - started}ms)`);
    await reader.cancel().catch(() => undefined);
  });

  test("streams deregister themselves when they finish normally", async () => {
    const finished = await createHarness();

    try {
      const response = await finished.request("/v1/agents/assistant/run/stream", post({ input: "quick" }));
      await response.text();

      assert.equal(finished.container.streams.size, 0, "a completed stream must not stay registered");
    } finally {
      await finished.close();
    }
  });
});

describe("metrics", () => {
  /** Reads a single Prometheus sample value. */
  function sample(body: string, name: string, labels: Record<string, string> = {}): number | null {
    const wanted = Object.entries(labels)
      .map(([key, value]) => `${key}="${value}"`)
      .sort();

    for (const line of body.split("\n")) {
      if (line.startsWith("#") || !line.startsWith(name)) continue;

      const match = /^([^\s{]+)(?:\{([^}]*)\})?\s+(\S+)$/.exec(line.trim());
      if (match?.[1] !== name) continue;

      const present = (match[2] ?? "")
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
        .sort();

      if (wanted.every((label) => present.includes(label))) return Number(match[3]);
    }
    return null;
  }

  test("exposes Prometheus text format without an API key", async () => {
    const response = await h.request("/metrics", { apiKey: null });

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/plain/);

    const body = await response.text();
    assert.match(body, /# HELP bugbaar_http_requests_total/);
    assert.match(body, /# TYPE bugbaar_http_requests_total counter/);
  });

  test("includes process metrics", async () => {
    const body = await (await h.request("/metrics", { apiKey: null })).text();
    assert.match(body, /bugbaar_process_cpu_user_seconds_total|bugbaar_nodejs_eventloop_lag_seconds/);
  });

  test("counts agent runs and their tool calls", async () => {
    const before = await (await h.request("/metrics", { apiKey: null })).text();
    const baseline = sample(before, "bugbaar_agent_runs_total", { agent: "assistant", outcome: "completed" }) ?? 0;

    await h.json("/v1/agents/assistant/run", post({ input: "count me", sessionId: "metrics-run" }));

    const after = await (await h.request("/metrics", { apiKey: null })).text();
    const counted = sample(after, "bugbaar_agent_runs_total", { agent: "assistant", outcome: "completed" });

    assert.equal(counted, baseline + 1);
    assert.ok(sample(after, "bugbaar_agent_run_duration_seconds_count", { agent: "assistant" })! >= 1);
  });

  test("counts a streamed run on the same metric as a blocking one", async () => {
    const before = await (await h.request("/metrics", { apiKey: null })).text();
    const baseline = sample(before, "bugbaar_agent_runs_total", { agent: "assistant", outcome: "completed" }) ?? 0;

    const response = await h.request("/v1/agents/assistant/run/stream", post({ input: "streamed count" }));
    await response.text();

    const after = await (await h.request("/metrics", { apiKey: null })).text();
    assert.equal(
      sample(after, "bugbaar_agent_runs_total", { agent: "assistant", outcome: "completed" }),
      baseline + 1,
    );
  });

  test("records workflow outcomes and pinpoints the failing step", async () => {
    await h.json("/v1/workflows/ingest-and-summarise/run", post({ input: { id: "m1", text: "ok" } }));
    await h.json("/v1/workflows/ingest-and-summarise/run", post({ input: {} }));

    const body = await (await h.request("/metrics", { apiKey: null })).text();

    assert.ok(
      sample(body, "bugbaar_workflow_runs_total", { workflow: "ingest-and-summarise", status: "succeeded" })! >= 1,
    );
    assert.ok(
      sample(body, "bugbaar_workflow_runs_total", { workflow: "ingest-and-summarise", status: "failed" })! >= 1,
    );
    assert.ok(
      sample(body, "bugbaar_workflow_step_failures_total", { workflow: "ingest-and-summarise", step: "ingest" })! >=
        1,
      "the failing step should be identifiable from metrics alone",
    );
  });

  /*
   * The guarantee that keeps this safe to run in production.
   *
   * A label built from the concrete path would mint a time series per agent
   * id, and a 404 scanner could create unbounded cardinality — enough to take
   * out a Prometheus server. Route templates keep the series count bounded by
   * the number of routes.
   */
  test("uses route templates as labels, so cardinality stays bounded", async () => {
    for (const id of ["alpha", "beta", "gamma"]) {
      await h.json("/v1/agents", post({ id }));
      await h.request(`/v1/agents/${id}`);
    }
    for (const path of ["/v1/nope-1", "/v1/nope-2", "/v1/nope-3"]) {
      await h.request(path);
    }

    const body = await (await h.request("/metrics", { apiKey: null })).text();
    const routes = new Set(
      body
        .split("\n")
        .filter((line) => line.startsWith("bugbaar_http_requests_total"))
        .map((line) => /route="([^"]*)"/.exec(line)?.[1])
        .filter((route): route is string => Boolean(route)),
    );

    assert.equal(
      [...routes].some((route) => /alpha|beta|gamma|nope/.test(route)),
      false,
      `a concrete path leaked into a metric label: ${[...routes].join(", ")}`,
    );
    assert.ok(routes.has("/v1/agents/:id"), "the route template should be the label");
    assert.ok(routes.has("unmatched"), "unmatched paths must collapse into one series");
  });

  test("counts rate-limited requests with the limiter's scope", async () => {
    const limited = await createHarness({ env: { RATE_LIMIT_MAX: "2", RATE_LIMIT_WINDOW_MS: "60000" }, seed: false });

    try {
      for (let i = 0; i < 5; i += 1) await limited.request("/v1/agents");

      const body = await (await limited.request("/metrics", { apiKey: null })).text();
      assert.ok(sample(body, "bugbaar_rate_limited_total", { scope: "local" })! >= 1);
    } finally {
      await limited.close();
    }
  });

  test("tracks open streams as a gauge", async () => {
    const streaming = await createHarness({ env: { ECHO_CHUNK_DELAY_MS: "300" } });

    try {
      const response = await fetch(`${streaming.baseUrl}/v1/agents/assistant/run/stream`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "test-key" },
        body: JSON.stringify({ input: "a b c d e f g h" }),
      });
      const reader = response.body!.getReader();
      await reader.read();

      const during = await (await streaming.request("/metrics", { apiKey: null })).text();
      assert.equal(sample(during, "bugbaar_streams_active"), 1);

      await reader.cancel().catch(() => undefined);
    } finally {
      await streaming.close();
    }
  });

  test("can be disabled", async () => {
    const off = await createHarness({ env: { METRICS_ENABLED: "false" }, seed: false });

    try {
      assert.equal((await off.request("/metrics", { apiKey: null })).status, 404);
    } finally {
      await off.close();
    }
  });
});
