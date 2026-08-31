# Security

Agent systems have a threat model ordinary web services do not: the model
decides what to call, and its instructions can arrive from text an attacker
controls. This document records the assumptions the engine makes.

## Reporting a vulnerability

Do not open a public issue. Email **security@bugbaar.dev** with reproduction
steps. You should get an acknowledgement within 72 hours.

## Trust boundaries

| Source                                   | Trust                                          |
| ---------------------------------------- | ---------------------------------------------- |
| API request from an authenticated client | Trusted to the limit of that key               |
| LLM output                               | **Untrusted.** Never execute it as code or SQL |
| Retrieved documents                      | **Untrusted.** Data, never instructions        |
| Tool results                             | Untrusted; they re-enter the prompt            |
| Environment configuration                | Trusted                                        |

## Prompt injection

An ingested document can contain "ignore previous instructions and…". The
engine's defences:

1. `RagPipeline.buildContext()` wraps retrieved text in `<document>` tags and
   states in the prompt that the content is reference data, not instructions.
2. Tools are allowlisted per agent. An agent holds only the tools named at
   construction, so a successful injection is bounded by that set.
3. `createHttpTool` requires an explicit host allowlist. Without one it
   reaches nothing, which blocks the usual exfiltration path.

These reduce risk; they do not eliminate it. Treat any agent that reads
untrusted text as capable of taking any action its tools permit, and scope
those tools accordingly.

## Tool safety

When you add a tool:

- **Allowlist outbound destinations.** Never let a model choose an arbitrary
  host — that is SSRF plus a data-exfiltration channel.
- **Never interpolate model output into a shell command or SQL string.**
- **Bound the work.** Every tool needs a timeout and an output cap; the HTTP
  tool truncates bodies at 100 KB.
- **Keep secrets out of arguments and results.** Everything a tool returns
  goes back into the prompt, and prompts get logged.

## Transport and gateway

- API-key comparison is constant time, so latency does not leak a partial match.
- `loadConfig()` refuses to boot in production without `API_KEYS`.
- Security headers are always on: `nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`, and `X-Powered-By` removed.
- Internal error messages are replaced with a generic string in production;
  the full error and stack go to the logs with the request id.
- Bodies are capped at 10 MB, and nginx caps them at 12 MB upstream.
- Set `CORS_ORIGIN` to your actual origin in production. The `*` default is a
  development convenience.

## Secrets

Never commit `.env`. `.gitignore` excludes it and `.dockerignore` keeps it out
of images. In production, inject configuration through your orchestrator's
secret store rather than a file on disk.

## Known limitations

These are deliberate gaps in the current scaffold, not oversights:

- Rate limiting is shared across replicas only when `REDIS_URL` is set;
  otherwise each replica enforces the limit independently. The
  `x-ratelimit-scope` response header says which is in effect.
- The rate limiter fails open when Redis is unreachable, trading enforcement
  for availability. If you need the opposite, change `rateLimit` in
  `backend/src/middleware/index.ts` to reject on limiter errors.
- Anyone holding an API key can enqueue jobs and create repeating schedules.
  There is no per-key quota on queue depth.
- API keys are static strings — there is no rotation, scoping, or revocation.
- Agent memory and run history are in-memory unless `MONGODB_URI` is set.
- The MongoDB connection carries no credentials of its own beyond the URI;
  scope that user to the engine's database and nothing else.
- Stored transcripts contain whatever users sent an agent. Treat the
  `agent_messages` collection as user data for retention and deletion
  purposes — `DELETE /v1/agents/:id/memory` is the only built-in eraser.
- There is no per-agent resource quota; a runaway loop is bounded only by
  `maxSteps`.
