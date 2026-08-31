# Getting Started

## Run it locally

```bash
npm install
cp .env.example .env
npm run build
npm run dev
```

The engine listens on `http://localhost:4000`. With the defaults it needs no
database, no vector store, and no API key: agent memory and vectors live in
memory, and the `echo` LLM provider answers without a network call. Every
endpoint works — the answers are just not intelligent yet.

## Your first request

```bash
curl -s http://localhost:4000/health
```

An example agent named `assistant` is seeded at boot:

```bash
curl -s -X POST http://localhost:4000/v1/agents/assistant/run \
  -H 'content-type: application/json' \
  -H 'x-api-key: dev-local-key' \
  -d '{"input":"What is 6 times 7?"}'
```

## Make it durable

By default the engine keeps agents, memory, and run history in process, so
everything is lost on restart. Point it at MongoDB to change that:

```bash
MONGODB_URI=mongodb://localhost:27017/bugbaar
```

Restart, and agents you created are rebuilt automatically — the startup log
reports `restored agents from storage`. `GET /health` shows `mongodb: "up"`
once the connection is live.

## Run workflows in the background

```bash
REDIS_URL=redis://localhost:6379
```

With Redis configured, queue a workflow instead of waiting for it:

```bash
curl -s -X POST http://localhost:4000/v1/workflows/ingest-and-summarise/enqueue   -H 'content-type: application/json'   -H 'x-api-key: dev-local-key'   -d '{"input":{"id":"notes","text":"Queued for background execution."}}'
```

That returns `202` with a job id. To run something on a repeating schedule:

```bash
curl -s -X POST http://localhost:4000/v1/schedules   -H 'content-type: application/json'   -H 'x-api-key: dev-local-key'   -d '{"id":"nightly","workflow":"ingest-and-summarise","cron":"0 3 * * *","input":{"text":"…"}}'
```

Schedules live in Redis, so they survive restarts and fire exactly once per
tick no matter how many replicas you run.

## Connect a real model

Set two variables in `.env` and restart:

```bash
LLM_PROVIDER=openai
OPENAI_API_KEY=sk-…
```

For a local model, run Ollama and use its OpenAI-compatible endpoint:

```bash
LLM_PROVIDER=ollama
OLLAMA_MODEL=llama3.1
```

Setting `OPENAI_API_KEY` also upgrades embeddings from the offline hashing
provider to `text-embedding-3-small`.

## Create your own agent

```bash
curl -s -X POST http://localhost:4000/v1/agents \
  -H 'content-type: application/json' \
  -H 'x-api-key: dev-local-key' \
  -d '{
    "id": "analyst",
    "goal": "Answer questions about our documentation.",
    "tools": ["calculator"],
    "maxSteps": 6
  }'
```

## Build a knowledge base

```bash
curl -s -X POST http://localhost:4000/v1/knowledge/documents \
  -H 'content-type: application/json' \
  -H 'x-api-key: dev-local-key' \
  -d '{"documents":[{"id":"retries","text":"Workflow steps retry with exponential backoff, doubling the delay after each failed attempt."}]}'

curl -s -X POST http://localhost:4000/v1/knowledge/ask \
  -H 'content-type: application/json' \
  -H 'x-api-key: dev-local-key' \
  -d '{"query":"how do retries work","agentId":"analyst"}'
```

## Run a workflow

```bash
curl -s http://localhost:4000/v1/workflows -H 'x-api-key: dev-local-key'

curl -s -X POST http://localhost:4000/v1/workflows/ingest-and-summarise/run \
  -H 'content-type: application/json' \
  -H 'x-api-key: dev-local-key' \
  -d '{"input":{"id":"notes","text":"BugBaar Engine is open-source infrastructure for AI agents."}}'
```

## Use the dashboard

```bash
npm run dev:frontend
```

Open `http://localhost:5173` and enter your API key in the header. The
dashboard creates agents, runs prompts with full step traces, ingests and
searches documents, triggers workflows, and shows engine health. Vite proxies
API calls to the engine on port 4000, so both must be running.

See [../frontend/README.md](../frontend/README.md) for details.

## Use the packages directly

The libraries work without the HTTP layer:

```ts
import { Agent, EchoProvider } from "@bugbaar/agents";
import { calculatorTool, ToolRegistry } from "@bugbaar/tools";

const agent = new Agent({
  id: "local",
  provider: new EchoProvider(),
  tools: new ToolRegistry([calculatorTool]),
});

console.log((await agent.run("hello")).output);
```

## Full stack with Docker

```bash
docker compose up --build
```

This starts the engine alongside MongoDB, Redis, and Qdrant, with the engine
already pointed at all three.

## Next steps

- [ARCHITECTURE.md](ARCHITECTURE.md) — how the modules fit together
- [API.md](API.md) — every endpoint
- [SECURITY.md](SECURITY.md) — the agent threat model
- [../CONTRIBUTING.md](../CONTRIBUTING.md) — adding tools and opening PRs
