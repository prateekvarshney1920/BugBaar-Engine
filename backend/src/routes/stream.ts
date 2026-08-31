import type { AgentEvent } from "@bugbaar/agents";
import { asObject, optionalString, requireString } from "@bugbaar/api";
import type { Response } from "express";
import { Router } from "express";
import { asyncHandler, HttpError, pathParam } from "../middleware/index.js";
import type { Container } from "../services/container.js";

/**
 * Server-sent events for a single agent run.
 *
 * SSE rather than WebSockets: the traffic is one-directional, it survives
 * proxies that only understand HTTP, and the browser reconnects on its own.
 * A socket would add a protocol and a handshake for no gain here.
 */
export function streamRoutes(container: Container): Router {
  const router = Router();

  router.post(
    "/agents/:id/run/stream",
    asyncHandler(async (req, res) => {
      const id = pathParam(req, "id");
      const agent = container.agents.get(id);
      if (!agent) throw new HttpError(404, "agent_not_found", `Agent "${id}" does not exist`);

      const body = asObject(req.body);
      const input = requireString(body, "input", { maxLength: 32_000 });
      const sessionId = optionalString(body, "sessionId", 128);

      openStream(res);

      // Registered so shutdown can end this stream; an open one would
      // otherwise keep server.close() waiting indefinitely.
      const unregister = container.streams.add(res);

      // A client that navigates away or hits stop should not leave the run
      // burning tokens on the server.
      const abort = new AbortController();
      req.on("close", () => abort.abort());
      res.on("close", () => abort.abort());

      let events = 0;
      container.metrics.agentRunsActive.inc();

      try {
        for await (const event of agent.stream(input, { sessionId, signal: abort.signal })) {
          if (res.writableEnded) break;
          send(res, event.type, event);
          events += 1;

          // Recorded here rather than after the loop: an aborted stream never
          // reaches run-end, and counting only completed runs would quietly
          // hide exactly the runs worth investigating.
          if (event.type === "run-end") container.observeAgentRun(event.result);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        req.log.error("stream failed", { agentId: id, message });

        // The response is already committed with a 200, so a failure cannot be
        // signalled by status code. It has to arrive as a final event.
        if (!res.writableEnded) send(res, "error", { type: "error", message, runId: "" } satisfies AgentEvent);
      } finally {
        container.metrics.agentRunsActive.dec();
        unregister();
        req.log.info("stream closed", { agentId: id, events, aborted: abort.signal.aborted });
        if (!res.writableEnded) res.end();
      }
    }),
  );

  return router;
}

function openStream(res: Response): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    // nginx buffers proxied responses by default, which would hold the whole
    // stream until the run finished — defeating the point.
    "x-accel-buffering": "no",
  });
  res.flushHeaders();
}

function send(res: Response, event: string, data: unknown): void {
  // Newlines inside a data field would be read as separate SSE lines, so the
  // payload is serialised to a single line of JSON.
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
