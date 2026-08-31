# API Reference

Base URL: `http://localhost:4000`
All application endpoints are versioned under `/v1`. Health endpoints are not.

## Authentication

Every `/v1` route requires an API key from the `API_KEYS` list:

```
x-api-key: dev-local-key
```

If `API_KEYS` is empty the gateway allows anonymous access — convenient in
development, and refused outright when `NODE_ENV=production`.

## Conventions

- Requests and responses are JSON. Bodies are capped at 10 MB.
- Every response carries an `x-request-id` header; send your own to correlate.
- Errors share one shape:

```json
{
  "error": { "code": "invalid_request", "message": "\"input\" is required and must be a non-empty string" },
  "requestId": "0f2b…"
}
```

| Code                                                   | Status | Meaning                                           |
| ------------------------------------------------------ | ------ | ------------------------------------------------- |
| `invalid_request`                                      | 400    | Body or path failed validation                    |
| `unauthorized`                                         | 401    | Missing or wrong `x-api-key`                      |
| `not_found` / `agent_not_found` / `workflow_not_found` | 404    | No such resource                                  |
| `agent_exists`                                         | 409    | Agent id already taken                            |
| `rate_limited`                                         | 429    | Window exhausted; see `retry-after`               |
| `internal_error`                                       | 500    | Unexpected failure (details logged, not returned) |

## Metrics

`GET /metrics` returns Prometheus text exposition. Like the health probes it is
**unauthenticated**, because a Prometheus scraper cannot present an API key.
The exposure is bounded on purpose: aggregate counters and low-cardinality
labels only — never prompts, transcripts, or identifiers. Restrict it at the
proxy or bind the engine to an internal interface if that is not acceptable.
Set `METRICS_ENABLED=false` to remove the route entirely.

| Metric                                  | Type      | Answers                                                    |
| --------------------------------------- | --------- | ---------------------------------------------------------- |
| `bugbaar_http_requests_total`           | counter   | Which routes are failing, by status                        |
| `bugbaar_http_request_duration_seconds` | histogram | Which routes are slow                                      |
| `bugbaar_agent_runs_total`              | counter   | Are runs completing, hitting `max_steps`, or being aborted |
| `bugbaar_agent_run_duration_seconds`    | histogram | How long runs take                                         |
| `bugbaar_agent_run_steps`               | histogram | A rising tail means agents are looping                     |
| `bugbaar_agent_runs_active`             | gauge     | Concurrency right now                                      |
| `bugbaar_tool_calls_total`              | counter   | Which tools fail, and how often                            |
| `bugbaar_tool_call_duration_seconds`    | histogram | Which tool is the bottleneck                               |
| `bugbaar_workflow_runs_total`           | counter   | Workflow success rate                                      |
| `bugbaar_workflow_step_failures_total`  | counter   | **Which step** is failing                                  |
| `bugbaar_jobs_enqueued_total`           | counter   | Background load                                            |
| `bugbaar_streams_active`                | gauge     | Open SSE connections                                       |
| `bugbaar_rate_limited_total`            | counter   | Throttling, by `shared`/`local` scope                      |

Plus Node process, heap, and event-loop-lag metrics under the same prefix
(`METRICS_DEFAULT=false` to omit them).

**Labels are route templates, never concrete paths.** A label built from
`/v1/agents/abc/run` would mint a time series per agent id, and a 404 scanner
could create unbounded cardinality — enough to take out a Prometheus server.
Unmatched paths collapse into a single `unmatched` series for the same reason.
There is a test asserting this.

## Health

| Method | Path            | Purpose                                   |
| ------ | --------------- | ----------------------------------------- |
| GET    | `/health`       | Full status with dependency map           |
| GET    | `/health/live`  | Liveness — is the process up              |
| GET    | `/health/ready` | Readiness — 503 when a dependency is down |

## Agents

### `GET /v1/agents`

Lists registered agents.

### `POST /v1/agents`

```json
{
  "id": "researcher",
  "name": "Research Assistant",
  "goal": "Answer questions with citations.",
  "instructions": "Be concise and cite sources.",
  "tools": ["calculator"],
  "maxSteps": 8
}
```

`id` must be alphanumeric with dashes or underscores. Unknown tool names are
rejected with the available list in `error.details`. Returns `201`.

### `GET /v1/agents/:id` · `DELETE /v1/agents/:id`

Fetch or remove one agent. Delete returns `204`.

### `POST /v1/agents/:id/run`

```json
{ "input": "What is 6 times 7?", "sessionId": "user-123" }
```

Response:

```json
{
  "runId": "8c1e…",
  "agentId": "researcher",
  "output": "42",
  "stoppedBecause": "completed",
  "steps": [
    { "index": 0, "thought": "I need to multiply.", "tools": [{ "name": "calculator", "ok": true, "durationMs": 1 }] }
  ],
  "durationMs": 412
}
```

`stoppedBecause` is `completed`, `max_steps`, or `aborted`. Omitting
`sessionId` uses the agent id, so all callers share one conversation — pass a
per-user value to keep them separate.

### `POST /v1/agents/:id/run/stream`

Identical body to `/run`, but the response is a `text/event-stream` that emits
each stage of the run as it happens rather than one payload at the end.

```
event: run-start
data: {"type":"run-start","runId":"0b49…","agentId":"assistant","input":"…"}

event: token
data: {"type":"token","index":0,"text":"echo:"}

event: tool-start
data: {"type":"tool-start","index":0,"call":{"id":"c1","name":"calculator"}}

event: tool-result
data: {"type":"tool-result","index":0,"result":{"ok":true,"durationMs":1}}

event: run-end
data: {"type":"run-end","result":{ …the same body /run returns… }}
```

| Event                        | Meaning                                           |
| ---------------------------- | ------------------------------------------------- |
| `run-start`                  | The run has an id; nothing has been generated yet |
| `step-start`                 | A reasoning step begins                           |
| `token`                      | A fragment of assistant text                      |
| `message`                    | The step's complete message, with any tool calls  |
| `tool-start` / `tool-result` | A tool was invoked, then finished                 |
| `run-end`                    | Carries the full run record                       |
| `error`                      | The run failed after the stream opened            |

Notes that matter to a client:

- **Validation happens before the stream opens.** A bad body or unknown agent
  returns a normal JSON error with a 4xx status. Once the stream is open the
  status is fixed at 200, so later failures arrive as an `error` event.
- **Providers without token streaming still emit `token`.** They send one
  covering the whole message, so a client needs only one rendering path.
- **Closing the connection cancels the run.** The server stops work rather than
  finishing a run nobody is listening to.
- `x-accel-buffering: no` is set because nginx would otherwise buffer the whole
  response and defeat the point.

### `GET /v1/agents/:id/memory` · `DELETE /v1/agents/:id/memory`

Read or clear a session transcript. Both accept `?sessionId=`.

### `GET /v1/tools`

Lists every registered tool with its JSON schema.

## Knowledge

### `POST /v1/knowledge/documents`

```json
{ "documents": [{ "id": "handbook", "text": "…", "metadata": { "team": "platform" } }] }
```

Chunks, embeds, and indexes each document. Re-posting the same `id` replaces
its chunks. Returns `201` with `{ "documents": 1, "chunks": 12 }`.

### `POST /v1/knowledge/search`

```json
{ "query": "how do retries work", "topK": 5, "filter": { "team": "platform" } }
```

Returns ranked chunks with cosine scores.

### `POST /v1/knowledge/ask`

```json
{ "query": "how do retries work", "agentId": "researcher", "topK": 5 }
```

Retrieves context, then asks the named agent. Returns the answer plus the
source documents that informed it.

### `DELETE /v1/knowledge/documents/:id` · `GET /v1/knowledge/stats`

Remove a document's chunks, or count what is indexed.

## Workflows

| Method | Path                          | Purpose                                           |
| ------ | ----------------------------- | ------------------------------------------------- |
| GET    | `/v1/workflows`               | List workflows and their steps                    |
| POST   | `/v1/workflows/:name/run`     | Execute inline with `{ "input": { … } }`          |
| POST   | `/v1/workflows/:name/enqueue` | Queue for background execution, returns `202`     |
| GET    | `/v1/workflows/runs`          | Recent runs, newest first (`?limit=`, default 50) |
| GET    | `/v1/workflows/runs/:runId`   | One run by id                                     |
| GET    | `/v1/schedules`               | Repeating jobs and their next run time            |
| POST   | `/v1/schedules`               | Create or replace a repeating job                 |
| DELETE | `/v1/schedules/:id`           | Cancel a repeating job                            |

### `POST /v1/workflows/:name/enqueue`

```json
{ "input": { "text": "…" }, "delayMs": 5000, "attempts": 3, "jobId": "my-id" }
```

Returns `202` with `{ "jobId", "workflow", "durable" }`. Supplying `jobId`
makes the call idempotent. `attempts` is a queue-level retry for a crashed
worker — distinct from a step's own retry policy.

### `POST /v1/schedules`

```json
{ "id": "nightly", "workflow": "ingest-and-summarise", "cron": "0 3 * * *", "input": {} }
```

Provide `every` (milliseconds, minimum 1000) or `cron`. Re-using an `id`
replaces the existing schedule rather than adding a second one. `cron`
requires Redis; the in-memory queue supports `every` only.

A run returns `200` when every step succeeded and `422` when one failed. The
body is the same `WorkflowRun` either way — status, per-step records, results,
and the error message.

## Persistence

With `MONGODB_URI` set, agent definitions, conversation memory, and workflow
run history are durable: an agent created through `POST /v1/agents` is rebuilt
automatically when the engine restarts, and its transcripts survive with it.

Without it the engine still works, but everything above is in-process and lost
on restart. `GET /health` reports which mode you are in — `mongodb: "up"` is a
live ping, `"not_configured"` means the in-memory fallback.

Run history is expired by MongoDB after `RUN_RETENTION_DAYS` (default 30); set
it to `0` to keep runs forever.

The example agent is re-created at boot whenever it is missing, including
after you delete it. Set `SEED_EXAMPLES=false` to stop that.

## Background jobs

Without `REDIS_URL` the engine still accepts `enqueue` and `schedules` calls,
but runs them on in-process timers: jobs are lost on restart, and every replica
fires its own copy of each repeating job. Every queue response includes
`durable` so a caller can tell which mode it is talking to.

With `REDIS_URL` set, jobs are BullMQ-backed: they survive restarts, any
replica can pick them up, a repeating job fires exactly once per tick across
the cluster, and a crashed worker's job is retried.

Set `QUEUE_START_WORKER=false` to enqueue without consuming — useful for an
API tier that should not execute workflows itself.

## Rate limiting

Fixed window, keyed by API key (falling back to client IP). Configure with
`RATE_LIMIT_WINDOW_MS` and `RATE_LIMIT_MAX`.

Responses carry `x-ratelimit-limit`, `x-ratelimit-remaining`, and
`x-ratelimit-scope`; a 429 adds `retry-after` in seconds. The scope header is
the one to watch:

- `shared` — counted in Redis, so the limit holds across every replica.
- `local` — counted in this process, so N replicas allow N times the limit.

If Redis becomes unreachable the limiter fails **open**: the request is allowed
and the failure is logged. An unlimited request beats a dead endpoint.
