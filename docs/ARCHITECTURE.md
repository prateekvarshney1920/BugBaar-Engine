# Architecture

BugBaar Engine is an npm workspace monorepo. Each module is a standalone
package with a narrow public interface, so it can be consumed on its own or
replaced without touching the rest of the system.

## Dependency graph

```text
        ┌─────────────┐
        │   backend   │  Express gateway: auth, rate limiting, routes
        └──────┬──────┘
               │
   ┌───────────┼───────────┬─────────────┬────────────┬─────────┐
   │           │           │             │            │         │
┌──▼───┐  ┌────▼────┐  ┌───▼───┐   ┌─────▼─────┐  ┌───▼────┐ ┌──▼───┐
│ api  │  │ agents  │  │  rag  │   │ workflows │  │persist.│ │queue │
└──────┘  └────┬────┘  └───────┘   └─────┬─────┘  └───┬────┘ └──┬───┘
               │                         │           │         │
          ┌────▼────┐                    └───────────┴─────────┘
          │  tools  │        persistence and queue implement interfaces
          └─────────┘        owned by agents and workflows
```

Dependencies flow downward only. `tools` depends on nothing; `backend` depends
on everything. A library package never imports the backend.

`persistence` and `queue` are the only packages that depend on external
drivers — MongoDB and Redis respectively. Every interface they satisfy —
`MemoryStore`, `AgentRepository`, `WorkflowRunStore`, `JobQueue`,
`RateLimiter` — lives in `agents` or `workflows` alongside an in-memory
implementation, so anyone consuming those packages directly pulls in no driver
at all.

## Request lifecycle

```text
client
  │  POST /v1/agents/assistant/run   x-api-key: …
  ▼
requestContext   assigns a request id, echoed as x-request-id
  ▼
securityHeaders  nosniff, DENY framing, no referrer
  ▼
cors + json      10 MB body cap
  ▼
apiKeyAuth       constant-time key comparison
  ▼
rateLimit        fixed window, keyed by API key
  ▼
route handler    validates the body, calls the container
  ▼
Agent.run()      provider → tool calls → provider → answer
  ▼
errorHandler     maps errors to typed JSON, hides internals in production
```

## The agent loop

The loop is written **once**, as an async generator that yields `AgentEvent`s
and returns the finished run. `stream()` exposes it directly; `run()` drains it
and returns the value. Two public shapes, one implementation — a separate
non-streaming path would inevitably drift from the streaming one.

It is bounded by `maxSteps`:

1. Send the transcript plus tool descriptions to the `LlmProvider`.
2. If the model returns no tool calls, its content is the answer — stop.
3. Otherwise execute every requested tool **concurrently** through the
   `ToolRegistry`. Tool calls in one turn are independent by contract.
4. Append each result as a `role: "tool"` message and repeat.

Tool failures are never thrown. They come back as `ok: false` results and are
fed to the model as text, so it can correct a bad argument instead of the whole
run collapsing.

## Streaming

`LlmProvider.stream()` is **optional**. A provider that cannot stream omits it,
and the agent falls back to `complete()` and emits the whole message as a
single `token` event. That keeps the contract honest — no provider has to fake
a capability — while guaranteeing consumers only ever need one rendering path.

The transport is server-sent events rather than WebSockets: the traffic is
one-directional, it survives proxies that only speak HTTP, and browsers
reconnect on their own. A socket would add a protocol and a handshake for no
gain.

Two details are load-bearing:

- **Validation runs before the stream opens.** Once headers are sent the status
  is fixed at 200, so a bad request has to be rejected first or a client would
  see a "successful" stream carrying an error.
- **Client disconnect aborts the run.** `req.on("close")` fires an
  `AbortController` that reaches the provider and the tool registry, so a
  closed tab stops costing tokens.

The OpenAI SSE decoding lives in `agents/src/sse.ts` as two pure classes rather
than inside the provider. Its hard parts — a network chunk splitting a line,
tool-call arguments arriving a few characters at a time across frames — are
untestable against a live API on demand, but trivial to test against fixtures.

## Provider abstraction

No vendor SDK appears in a library package. `LlmProvider` and
`EmbeddingProvider` are interfaces implemented over plain `fetch`:

| Implementation             | Use                                                       |
| -------------------------- | --------------------------------------------------------- |
| `EchoProvider`             | Offline development and tests; no network calls           |
| `OpenAiProvider`           | Any OpenAI-compatible endpoint — including Ollama's `/v1` |
| `HashingEmbeddingProvider` | Deterministic offline embeddings                          |
| `OpenAiEmbeddingProvider`  | Production embeddings                                     |

Because Ollama exposes an OpenAI-compatible API, local models need no separate
adapter — only a different `baseUrl`.

## RAG pipeline

```text
Document ──chunkDocument──▶ Chunk[] ──embed──▶ EmbeddedChunk[] ──upsert──▶ VectorStore
                                                                              │
query ────────────────────embed───────────────────────────────search─────────┘
                                                                │
                                                       filter by minScore
                                                                │
                                                        buildContext()
```

Chunking prefers paragraph, then sentence, then word boundaries so chunks
rarely end mid-thought. Re-ingesting a document deletes its existing chunks
first, so edits never leave stale text in the index.

`buildContext()` wraps retrieved text in `<document>` tags and states
explicitly that the content is reference data, not instructions.

## Workflow engine

Steps run sequentially and read earlier outputs through `context.results`.
Per step you get retries with exponential backoff, a timeout, a `when`
condition, and `alwaysRun` for cleanup that must survive a failure.

A failure stops subsequent steps but the run still returns a full
`WorkflowRun` record — every step's status, attempt count, and duration — so a
failed run is as inspectable as a successful one.

## Storage

| Concern           | Default (dev)             | Production              |
| ----------------- | ------------------------- | ----------------------- |
| Agent definitions | `InMemoryAgentRepository` | `MongoAgentRepository`  |
| Agent memory      | `InMemoryStore`           | `MongoMemoryStore`      |
| Run history       | `InMemoryRunStore`        | `MongoWorkflowRunStore` |
| Vectors           | `InMemoryVectorStore`     | Qdrant                  |
| Background jobs   | `InMemoryJobQueue`        | `BullJobQueue` (Redis)  |
| Rate limiting     | `InMemoryRateLimiter`     | `RedisRateLimiter`      |

Selection happens in `Container.ready()`, driven by `MONGODB_URI`. Every
default is in-memory so a fresh clone runs with zero infrastructure; setting
one environment variable makes agents, memory, and run history durable.

## Restart behaviour

With MongoDB configured, `Container.ready()` reads every stored
`AgentDefinition` and rebuilds a live `Agent` from it. A definition holds only
serialisable configuration — id, goal, instructions, tool _names_, step limit —
never a provider or a tool implementation, which are re-resolved from the
current process.

One consequence is deliberate: a definition can outlive the tool that satisfied
it. If a tool is dropped from the catalogue between deploys, restoring that
agent throws. Startup logs the failure and skips that agent rather than
aborting, so one stale definition cannot stop the engine from booting.

## Background jobs

`POST /v1/workflows/:name/run` executes inline and returns the finished run.
`POST /v1/workflows/:name/enqueue` returns `202` immediately and a worker picks
the job up. Both paths call `Container.runWorkflow()`, so a run is recorded
identically whichever triggered it.

Every queue response carries `durable`, because the two modes differ in ways
callers need to know about:

|                                 | `InMemoryJobQueue`     | `BullJobQueue` |
| ------------------------------- | ---------------------- | -------------- |
| Survives a restart              | no                     | yes            |
| Repeating job across N replicas | fires N times per tick | fires once     |
| Retry after a worker crash      | no                     | yes            |
| Cron expressions                | no                     | yes            |

One subtlety in the worker: a workflow that _ran_ and reported `failed` is a
**successful job**. The engine did its work and recorded the outcome, so
throwing there would make BullMQ retry a deterministically-failing workflow
several times for nothing. Only infrastructure errors — an unknown workflow
name, a crashed process — escape and trigger a retry.

## Contract tests

`InMemoryVectorStore` and `QdrantVectorStore` once disagreed about metadata
filtering: the in-memory store read `chunk.metadata[key]` while Qdrant queried
a top-level payload field. Filters worked locally and silently returned nothing
in production. Testing each store separately never surfaced it.

`rag/src/store-contract.ts` is now one suite that both backends must satisfy,
run against the in-memory store with no infrastructure and against a real
Qdrant when one is reachable. A new backend — pgvector, Pinecone — should be
added there first.

The same principle applies elsewhere: `persistence` and `queue` are tested
against real MongoDB and Redis, never mocks. The bugs worth catching in an
adapter are precisely the ones a mock is written not to have.

## Observability

Three layers, each answering a different question:

| Layer           | Question                            | Where                                |
| --------------- | ----------------------------------- | ------------------------------------ |
| Structured logs | What happened in this one request?  | stdout, correlated by `x-request-id` |
| Metrics         | Is the system healthy in aggregate? | `/metrics`                           |
| Run records     | What did this specific run do?      | `GET /v1/workflows/runs/:runId`      |

Instrumentation hangs off seams that already existed rather than being
sprinkled through the code: `Container.runWorkflow` covers every workflow run
whichever path triggered it, `Container.observeAgentRun` covers both the
blocking and streaming agent routes, and one middleware covers all HTTP.

Two decisions are load-bearing:

**Label cardinality is bounded by design.** Agent id, workflow name, tool name,
and route template are all bounded by configuration. Run ids, session ids, and
concrete paths are not, so they never appear as labels — they live in run
records and logs, which are queried by id rather than aggregated.

**A streamed run is recorded when its `run-end` event fires, not after the
loop.** An aborted stream never reaches `run-end`; counting only what completed
would quietly hide exactly the runs worth investigating.

## Extension points

| To add…           | Implement             | Register in                |
| ----------------- | --------------------- | -------------------------- |
| A tool            | `Tool`                | `container.registerTool()` |
| An LLM backend    | `LlmProvider`         | `createLlmProvider()`      |
| A vector database | `VectorStore`         | `createVectorStore()`      |
| A memory backend  | `MemoryStore`         | `Container` constructor    |
| A workflow        | `new Workflow({...})` | `container.workflows`      |
