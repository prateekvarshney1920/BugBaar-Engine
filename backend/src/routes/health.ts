import type { HealthResponse } from "@bugbaar/api";
import { Router } from "express";
import { asyncHandler } from "../middleware/index.js";
import type { Container } from "../services/container.js";

export function healthRoutes(container: Container): Router {
  const router = Router();

  router.get(
    "/health",
    asyncHandler(async (_req, res) => {
      const dependencies = await container.dependencyStatus();
      const body: HealthResponse = {
        status: Object.values(dependencies).includes("down") ? "degraded" : "ok",
        uptimeSeconds: Math.round((Date.now() - container.startedAt) / 1000),
        version: process.env.npm_package_version ?? "0.1.0",
        dependencies,
      };
      res.json(body);
    }),
  );

  // Liveness: the process is up. Kubernetes restarts the pod if this fails.
  router.get("/health/live", (_req, res) => res.json({ status: "ok" }));

  // Readiness: dependencies are reachable, so traffic can be routed here.
  router.get(
    "/health/ready",
    asyncHandler(async (_req, res) => {
      const dependencies = await container.dependencyStatus();
      const ready = !Object.values(dependencies).includes("down");
      res.status(ready ? 200 : 503).json({ status: ready ? "ok" : "not_ready", dependencies });
    }),
  );

  return router;
}
