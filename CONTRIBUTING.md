# Contributing to BugBaar Engine

Thanks for helping build open AI infrastructure. This guide covers everything
you need to make your first change.

## Prerequisites

- Node.js 20 or newer
- npm 10 or newer
- Docker (optional — only needed for MongoDB, Redis, and Qdrant)

## Getting started

```bash
git clone https://github.com/Bugbaar/BugBaar-Engine.git
cd BugBaar-Engine
npm install
cp .env.example .env
npm run build
npm test
npm run dev
```

The engine starts on `http://localhost:4000`. With no API keys or LLM
credentials configured it runs fully offline: an echo LLM provider, an
in-memory vector store, and in-memory agent memory. That is enough to exercise
every endpoint.

## Repository layout

This is an npm workspace monorepo. Each top-level directory is a package that
builds independently:

| Package           | Name                   | Responsibility                                     |
| ----------------- | ---------------------- | -------------------------------------------------- |
| `tools/`          | `@bugbaar/tools`       | Tool definitions, schema validation, registry      |
| `agents/`         | `@bugbaar/agents`      | LLM providers, memory, the agent loop              |
| `rag/`            | `@bugbaar/rag`         | Chunking, embeddings, vector stores, retrieval     |
| `workflows/`      | `@bugbaar/workflows`   | Step orchestration, retries, events, scheduling    |
| `persistence/`    | `@bugbaar/persistence` | MongoDB implementations of the storage interfaces  |
| `queue/`          | `@bugbaar/queue`       | BullMQ job queue and shared rate limiting on Redis |
| `api/`            | `@bugbaar/api`         | Shared HTTP contracts and request validation       |
| `backend/`        | `@bugbaar/backend`     | Express API gateway                                |
| `frontend/`       | `@bugbaar/frontend`    | React + Vite dashboard                             |
| `infrastructure/` | —                      | Dockerfile, nginx, deployment assets               |
| `docs/`           | —                      | Architecture and API reference                     |

Dependencies flow one way: `tools` → `agents` → `backend`. Never import
`backend` from a library package.

## Commands

| Command                  | What it does                         |
| ------------------------ | ------------------------------------ |
| `npm run build`          | Type-check and compile every package |
| `npm test`               | Run the unit test suite              |
| `npm run dev`            | Start the backend with hot reload    |
| `npm run dev:frontend`   | Start the dashboard on port 5173     |
| `npm run build:frontend` | Type-check and bundle the dashboard  |
| `npm run clean`          | Remove all build output              |

## Testing philosophy

Adapters are tested against the real thing, never a mock: MongoDB via
`mongodb-memory-server`, Redis and Qdrant via a service container. The bugs
worth catching in an adapter are exactly the ones a mock is written not to
have — a metadata filter that queries the wrong key path, a queue name the
library rejects. Both shipped and both were caught this way.

Where two implementations satisfy one interface, test them with a shared
contract (see `rag/src/store-contract.ts`) so they cannot drift apart.

A suite that skips when infrastructure is missing must set that flag **before**
tests are registered — `node:test` reads a test's options at registration, so a
flag set in `before()` leaves everything skipped while the run still reports
success. CI provides real services so nothing skips there.

## Code standards

- **TypeScript strict mode.** No `any`, no `@ts-ignore`. If the types fight
  you, the design usually needs a second look.
- **No vendor SDKs in library packages.** Providers talk to HTTP APIs through
  `fetch` behind an interface, so swapping a backend never touches call sites.
- **Errors carry context.** Include the id, name, or value that failed.
- **Comment the why, not the what.** Explain the constraint or trade-off that
  is not obvious from reading the code.
- **Tests are behavioural.** Assert what a caller observes, not internals.

## Adding a tool

```ts
import type { Tool } from "@bugbaar/tools";

export const weatherTool: Tool<{ city: string }, string> = {
  name: "weather",
  description: "Look up the current weather for a city.",
  parameters: {
    type: "object",
    properties: { city: { type: "string", description: "City name" } },
    required: ["city"],
    additionalProperties: false,
  },
  async execute({ city }) {
    return `It is pleasant in ${city}.`;
  },
};
```

Register it in `backend/src/services/container.ts` via `container.registerTool()`.

## Security expectations

Agent tools run with the engine's privileges. When you add one:

- Bound every outbound request with an explicit allowlist (see
  `createHttpTool`). An agent steered by untrusted text must not be able to
  reach arbitrary hosts.
- Never interpolate agent-produced strings into shell commands or SQL.
- Treat retrieved documents as data, never as instructions.

See [docs/SECURITY.md](docs/SECURITY.md) for the full threat model.

## Pull requests

1. Branch from `main`: `git checkout -b feat/short-description`
2. Make the change, with tests.
3. Confirm `npm run build` and `npm test` both pass.
4. Open a PR describing what changed and why.

Use conventional commit prefixes: `feat:`, `fix:`, `docs:`, `refactor:`,
`test:`, `chore:`.

## Good first issues

Look for `good-first-issue`, `help-wanted`, and `documentation` labels. Adding
a tool, an example agent, or a missing test is a great first contribution.
