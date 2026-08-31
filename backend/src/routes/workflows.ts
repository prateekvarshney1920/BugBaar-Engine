import { asObject, optionalNumber, optionalString, requireString, type WorkflowSummary } from "@bugbaar/api";
import { Router } from "express";
import { asyncHandler, HttpError, pathParam } from "../middleware/index.js";
import type { Container } from "../services/container.js";

export function workflowRoutes(container: Container): Router {
  const router = Router();

  const requireWorkflow = (name: string): void => {
    if (!container.workflows.has(name)) {
      throw new HttpError(404, "workflow_not_found", `Workflow "${name}" does not exist`);
    }
  };

  router.get("/workflows", (_req, res) => {
    const workflows: WorkflowSummary[] = [...container.workflows.values()].map((workflow) => ({
      name: workflow.name,
      description: workflow.description,
      steps: workflow.steps.map((step) => ({ name: step.name, description: step.description })),
    }));
    res.json({ workflows });
  });

  /** Runs the workflow inline and returns the completed run. */
  router.post(
    "/workflows/:name/run",
    asyncHandler(async (req, res) => {
      const name = pathParam(req, "name");
      requireWorkflow(name);

      const body = req.body === undefined ? {} : asObject(req.body);
      const input = body.input === undefined ? {} : asObject(body.input, "input");

      const run = await container.runWorkflow(name, input);
      req.log.info("workflow finished", { workflow: name, status: run.status, durationMs: run.durationMs });

      // A failed run is a completed request carrying a full record, not a
      // server error — 422 says "this ran and did not succeed".
      res.status(run.status === "succeeded" ? 200 : 422).json(run);
    }),
  );

  /** Queues the workflow for background execution and returns immediately. */
  router.post(
    "/workflows/:name/enqueue",
    asyncHandler(async (req, res) => {
      const name = pathParam(req, "name");
      requireWorkflow(name);

      const body = req.body === undefined ? {} : asObject(req.body);
      const input = body.input === undefined ? {} : asObject(body.input, "input");

      const jobId = await container.jobs.enqueue(name, input, {
        delayMs: optionalNumber(body, "delayMs", { min: 0, max: 86_400_000 }),
        attempts: optionalNumber(body, "attempts", { min: 1, max: 10 }),
        jobId: optionalString(body, "jobId", 128),
      });

      container.metrics.jobsEnqueued.inc({ workflow: name });
      req.log.info("workflow enqueued", { workflow: name, jobId, durable: container.jobs.durable });

      res.status(202).json({
        jobId,
        workflow: name,
        // Callers deserve to know whether this job would survive a restart.
        durable: container.jobs.durable,
      });
    }),
  );

  router.get(
    "/workflows/runs",
    asyncHandler(async (req, res) => {
      const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : 50;
      res.json({ runs: await container.runStore.recent(Number.isFinite(limit) ? limit : 50) });
    }),
  );

  router.get(
    "/workflows/runs/:runId",
    asyncHandler(async (req, res) => {
      const runId = pathParam(req, "runId");
      const run = await container.runStore.get(runId);
      if (!run) throw new HttpError(404, "run_not_found", `Run "${runId}" does not exist`);
      res.json(run);
    }),
  );

  router.get(
    "/schedules",
    asyncHandler(async (_req, res) => {
      res.json({ durable: container.jobs.durable, jobs: await container.jobs.list() });
    }),
  );

  router.post(
    "/schedules",
    asyncHandler(async (req, res) => {
      const body = asObject(req.body);
      const id = requireString(body, "id", { maxLength: 128 });
      const workflow = requireString(body, "workflow", { maxLength: 128 });
      requireWorkflow(workflow);

      const every = optionalNumber(body, "every", { min: 1_000, max: 86_400_000 });
      const cron = optionalString(body, "cron", 128);
      if (!every && !cron) {
        throw new HttpError(400, "invalid_request", 'A schedule needs "every" (milliseconds) or "cron"');
      }

      const input = body.input === undefined ? {} : asObject(body.input, "input");

      await container.jobs.schedule({
        id,
        workflow,
        input,
        repeat: { ...(every ? { every } : {}), ...(cron ? { cron } : {}) },
      });

      req.log.info("schedule created", { jobId: id, workflow, every, cron, durable: container.jobs.durable });
      res.status(201).json({ id, workflow, repeat: { every, cron }, durable: container.jobs.durable });
    }),
  );

  router.delete(
    "/schedules/:id",
    asyncHandler(async (req, res) => {
      const jobId = pathParam(req, "id");
      if (!(await container.jobs.cancel(jobId))) {
        throw new HttpError(404, "job_not_found", `Scheduled job "${jobId}" does not exist`);
      }
      res.status(204).end();
    }),
  );

  return router;
}
