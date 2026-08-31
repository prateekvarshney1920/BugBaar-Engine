import express, { type Express } from "express";
import type { Config } from "./config/index.js";
import type { Logger } from "./config/logger.js";
import {
  accessLog,
  apiKeyAuth,
  cors,
  errorHandler,
  httpMetrics,
  notFound,
  rateLimit,
  requestContext,
  securityHeaders,
} from "./middleware/index.js";
import { agentRoutes } from "./routes/agents.js";
import { healthRoutes } from "./routes/health.js";
import { knowledgeRoutes } from "./routes/knowledge.js";
import { metricsRoutes } from "./routes/metrics.js";
import { streamRoutes } from "./routes/stream.js";
import { workflowRoutes } from "./routes/workflows.js";
import type { Container } from "./services/container.js";

/**
 * Builds the Express application.
 *
 * Kept separate from `server.ts` so tests can mount the app without binding a
 * port or installing signal handlers.
 */
export function createApp(container: Container, config: Config, logger: Logger): Express {
  const app = express();

  app.disable("x-powered-by");
  app.set("trust proxy", true);

  app.use(requestContext(logger));
  app.use(securityHeaders());
  app.use(cors(config.corsOrigin));
  app.use(express.json({ limit: "10mb" }));
  app.use(accessLog());
  app.use(httpMetrics(container.metrics));

  // Health checks stay unauthenticated so orchestrators can probe them.
  app.use(healthRoutes(container));
  // Scraped by Prometheus, which cannot present an API key, so it sits outside
  // the authenticated router alongside the health probes. Bind the engine to an
  // internal interface or restrict /metrics at the proxy in production.
  if (config.metrics.enabled) app.use(metricsRoutes(container));

  const api = express.Router();
  api.use(apiKeyAuth(config));
  api.use(rateLimit(config, container.rateLimiter, container.metrics));
  api.use(agentRoutes(container));
  api.use(streamRoutes(container));
  api.use(knowledgeRoutes(container));
  api.use(workflowRoutes(container));
  app.use("/v1", api);

  app.use(notFound());
  app.use(errorHandler(config));

  return app;
}
