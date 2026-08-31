# Dashboard

React + Vite dashboard for BugBaar Engine. It talks to the REST API documented
in [../docs/API.md](../docs/API.md) and imports its request and response types
from `@bugbaar/api`, so a contract change surfaces as a type error here rather
than a runtime surprise.

## Running it

Start the engine first, then the dashboard:

```bash
npm run dev            # engine on :4000
npm run dev:frontend   # dashboard on :5173
```

Vite proxies `/v1` and `/health` to `http://localhost:4000`, so the browser
makes same-origin requests and the dashboard never depends on the gateway's
CORS configuration. Point it elsewhere with `ENGINE_URL`:

```bash
ENGINE_URL=https://engine.example.com npm run dev:frontend
```

Enter your API key in the header field. It is kept in `localStorage` and sent
as `x-api-key` on every request.

## Views

| View           | What it does                                                    |
| -------------- | --------------------------------------------------------------- |
| **Agents**     | Create agents, grant them tools from the registry, delete them  |
| **Playground** | Run a prompt and inspect every step, tool call, and duration    |
| **Knowledge**  | Ingest documents, run semantic search, see chunk counts         |
| **Workflows**  | Run workflows and read run history, per-step status and retries |
| **Monitoring** | Engine health and dependency status, polled every 10s           |

## Build

```bash
npm run build:frontend
```

`tsc --noEmit` runs first, so a type error fails the build before Vite emits
anything. Output lands in `frontend/dist/`.

## Notes on the code

- **No component library or state manager.** The dependency list is React,
  React DOM, and Vite. Views own their own fetch-and-render state; nothing here
  is complex enough yet to need more.
- **Errors surface with context.** `ErrorBanner` renders the engine's error
  code and the `x-request-id`, so a failure in the UI can be traced to a line
  in the server log.
- **A 422 from a workflow run is not an error.** A failed workflow returns a
  full run record with a 422 status; the client returns it as data so the UI
  can show which step failed and how many attempts it made.
- **Theming follows `prefers-color-scheme`** through CSS custom properties.

## Not built yet

- Streaming agent runs (the API returns a completed run, not a token stream)
- A visual workflow builder — this only runs workflows the backend registers
- Agent memory browsing and transcript replay
- Auth beyond a single static API key
