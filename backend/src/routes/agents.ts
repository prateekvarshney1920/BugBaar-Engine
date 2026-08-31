import {
  asObject,
  optionalNumber,
  optionalString,
  requireString,
  RequestValidationError,
  type AgentSummary,
  type RunAgentResponse,
} from "@bugbaar/api";
import type { Agent, AgentDefinition } from "@bugbaar/agents";
import { Router } from "express";
import { asyncHandler, HttpError, pathParam } from "../middleware/index.js";
import type { Container } from "../services/container.js";

export function agentRoutes(container: Container): Router {
  const router = Router();

  const summarise = (agent: Agent, createdAt: string): AgentSummary => ({
    id: agent.id,
    name: agent.name,
    tools: agent.tools.list().map((tool) => tool.name),
    createdAt,
  });

  router.get(
    "/agents",
    asyncHandler(async (_req, res) => {
      // The repository is the source of truth for what exists and when it was
      // created; the in-process map only holds the live instances.
      const definitions = await container.agentRepository.list();
      res.json({
        agents: definitions.flatMap((definition) => {
          const agent = container.agents.get(definition.id);
          return agent ? [summarise(agent, definition.createdAt)] : [];
        }),
      });
    }),
  );

  router.post(
    "/agents",
    asyncHandler(async (req, res) => {
      const body = asObject(req.body);
      const id = requireString(body, "id", { maxLength: 64 });

      if (!/^[a-z0-9][a-z0-9_-]*$/i.test(id)) {
        throw new RequestValidationError('"id" must be alphanumeric with dashes or underscores');
      }

      const definition: AgentDefinition = {
        id,
        name: optionalString(body, "name", 128),
        goal: optionalString(body, "goal", 2_000),
        instructions: optionalString(body, "instructions", 8_000),
        maxSteps: optionalNumber(body, "maxSteps", { min: 1, max: 32 }),
        tools: body.tools === undefined ? [] : requireStringArray(body.tools),
        createdAt: new Date().toISOString(),
      };

      // Order matters here, and each step guards a distinct failure:
      //
      // 1. Validate tool names first, so an unusable definition never reaches
      //    the database.
      // 2. Insert atomically, so two concurrent requests for the same id
      //    cannot both succeed with the second silently overwriting the first.
      // 3. Register the live agent only once the write has committed. Doing it
      //    earlier leaves an agent callable in this replica but unpersisted,
      //    which disappears on restart with no trace.
      try {
        container.registryFor(definition.tools);
      } catch (error) {
        throw new RequestValidationError(error instanceof Error ? error.message : String(error), {
          available: container.toolCatalog().map((tool) => tool.name),
        });
      }

      if (!(await container.agentRepository.create(definition))) {
        throw new HttpError(409, "agent_exists", `Agent "${id}" already exists`);
      }

      const agent = container.materialise(definition);
      req.log.info("agent created", { agentId: id, tools: definition.tools, persistent: container.persistent });

      res.status(201).json(summarise(agent, definition.createdAt));
    }),
  );

  /*
   * Registered before "/agents/:id" on purpose.
   *
   * Express matches in registration order, so declaring these later would let
   * "/agents/:id" capture "runs" as an agent id and answer 404 for every run
   * lookup. There is a test asserting this ordering.
   */
  router.get(
    "/agents/runs",
    asyncHandler(async (req, res) => {
      const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : 50;
      const agentId = typeof req.query.agentId === "string" ? req.query.agentId : undefined;

      const runs = await container.agentRunStore.recent(Number.isFinite(limit) ? limit : 50, {
        ...(agentId === undefined ? {} : { agentId }),
      });

      res.json({ runs });
    }),
  );

  router.get(
    "/agents/runs/:runId",
    asyncHandler(async (req, res) => {
      const runId = pathParam(req, "runId");
      const run = await container.agentRunStore.get(runId);
      if (!run) throw new HttpError(404, "run_not_found", `Agent run "${runId}" does not exist`);
      res.json(run);
    }),
  );

  router.get(
    "/agents/:id",
    asyncHandler(async (req, res) => {
      const id = pathParam(req, "id");
      const definition = await container.agentRepository.get(id);
      if (!definition) throw new HttpError(404, "agent_not_found", `Agent "${id}" does not exist`);

      res.json(summarise(getAgent(container, id), definition.createdAt));
    }),
  );

  router.delete(
    "/agents/:id",
    asyncHandler(async (req, res) => {
      const id = pathParam(req, "id");
      const removed = await container.agentRepository.delete(id);
      if (!removed) throw new HttpError(404, "agent_not_found", `Agent "${id}" does not exist`);

      container.agents.delete(id);
      res.status(204).end();
    }),
  );

  router.post(
    "/agents/:id/run",
    asyncHandler(async (req, res) => {
      const agent = getAgent(container, pathParam(req, "id"));
      const body = asObject(req.body);
      const input = requireString(body, "input", { maxLength: 32_000 });
      const sessionId = optionalString(body, "sessionId", 128);

      container.metrics.agentRunsActive.inc();

      // The runId only exists once the loop starts, so the run record is
      // opened from the event stream rather than before the call.
      const onEvent = container.agentRunRecorder({ sessionId });
      let runId = "";

      let result;
      try {
        result = await agent.run(input, {
          sessionId,
          onEvent: (event) => {
            if (event.type === "run-start") runId = event.runId;
            onEvent(event);
          },
        });
      } catch (error) {
        // A run that threw still started, and the record of why it stopped is
        // the most useful thing it can leave behind.
        if (runId) await container.failAgentRun(runId, error instanceof Error ? error.message : String(error));
        throw error;
      } finally {
        container.metrics.agentRunsActive.dec();
      }

      container.observeAgentRun(result);
      await container.completeAgentRun(result);
      await container.events.emit("agent.run.completed", { agentId: agent.id, runId: result.runId });

      const response: RunAgentResponse = {
        runId: result.runId,
        agentId: result.agentId,
        output: result.output,
        stoppedBecause: result.stoppedBecause,
        steps: result.steps.map((step) => ({
          index: step.index,
          thought: step.thought,
          tools: step.toolResults.map((tool) => ({ name: tool.name, ok: tool.ok, durationMs: tool.durationMs })),
        })),
        durationMs: result.durationMs,
      };

      res.json(response);
    }),
  );

  router.get(
    "/agents/:id/memory",
    asyncHandler(async (req, res) => {
      const agent = getAgent(container, pathParam(req, "id"));
      const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : agent.id;
      res.json({ sessionId, messages: await agent.memory.history(sessionId) });
    }),
  );

  router.delete(
    "/agents/:id/memory",
    asyncHandler(async (req, res) => {
      const agent = getAgent(container, pathParam(req, "id"));
      const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : agent.id;
      await agent.memory.clear(sessionId);
      res.status(204).end();
    }),
  );

  router.get("/tools", (_req, res) => {
    res.json({
      tools: container.toolCatalog().map(({ name, description, parameters }) => ({ name, description, parameters })),
    });
  });

  return router;
}

function getAgent(container: Container, id: string): Agent {
  const agent = container.agents.get(id);
  if (!agent) throw new HttpError(404, "agent_not_found", `Agent "${id}" does not exist`);
  return agent;
}

function requireStringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new RequestValidationError('"tools" must be an array of strings');
  }
  return value as string[];
}
