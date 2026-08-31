import { Router } from "express";
import { asyncHandler } from "../middleware/index.js";
import type { Container } from "../services/container.js";

/**
 * Prometheus scrape endpoint.
 *
 * Unauthenticated, like the health probes: a Prometheus scraper cannot present
 * an API key. The exposure is deliberate and bounded — the metrics carry
 * aggregate counters and low-cardinality labels, never prompts, transcripts, or
 * identifiers. Restrict it at the proxy or bind the engine to an internal
 * interface if that is not acceptable in your environment.
 */
export function metricsRoutes(container: Container): Router {
  const router = Router();

  container.metrics.streamsActive.set(0);
  container.streams.onChange((size) => container.metrics.streamsActive.set(size));

  router.get(
    "/metrics",
    asyncHandler(async (_req, res) => {
      const { contentType, body } = await container.metrics.render();
      res.setHeader("content-type", contentType);
      res.send(body);
    }),
  );

  return router;
}
