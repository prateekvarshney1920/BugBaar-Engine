import type { AgentRunResult, AgentRunStep } from "./types.js";

/**
 * Durable record of agent executions.
 *
 * Workflow runs already had this; agent runs did not, so an agent produced an
 * answer and left nothing behind to inspect afterwards.
 *
 * Unlike a workflow run, an agent run is recorded in two phases. The runId only
 * exists once the loop has started, and a run can take minutes or hang
 * entirely, so a record is written at `start` and patched at the end. A run
 * left in `running` is therefore meaningful: it is one that never reported
 * back, which is exactly what you want to see when diagnosing a stuck agent.
 */
export type AgentRunStatus = "running" | "completed" | "failed";

/** One tool invocation as it appears in a stored trace. */
export interface AgentRunToolCall {
  name: string;
  ok: boolean;
  durationMs: number;
  error?: string;
}

/**
 * One reasoning step of the trace.
 *
 * Derived from `AgentRunStep` rather than being a second description of it:
 * the model's message plus the tools it invoked and how they went.
 */
export interface AgentRunTraceStep {
  index: number;
  thought: string;
  tools: AgentRunToolCall[];
}

export interface AgentRunRecord {
  runId: string;
  agentId: string;
  sessionId?: string;
  input: string;
  status: AgentRunStatus;
  /** Present once the loop finished; absent while running or on error. */
  stoppedBecause?: AgentRunResult["stoppedBecause"];
  output?: string;
  steps: AgentRunTraceStep[];
  error?: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
}

export interface AgentRunStart {
  runId: string;
  agentId: string;
  input: string;
  sessionId?: string;
  startedAt?: string;
}

export interface RecentAgentRunsOptions {
  /** Restrict to one agent. */
  agentId?: string;
}

export interface AgentRunStore {
  /** Records a run as started. Safe to call once per runId. */
  start(run: AgentRunStart): Promise<void>;
  /** Marks a run completed and stores its trace. */
  complete(result: AgentRunResult): Promise<void>;
  /** Marks a run failed, keeping whatever was already recorded. */
  fail(runId: string, error: string): Promise<void>;
  get(runId: string): Promise<AgentRunRecord | null>;
  recent(limit?: number, options?: RecentAgentRunsOptions): Promise<AgentRunRecord[]>;
}

/**
 * Flattens the runtime's steps into the trace shape.
 *
 * The full `ToolResult` carries the tool's output, which can be arbitrarily
 * large and is already in the conversation transcript. A trace needs to answer
 * "what ran, did it work, how long did it take" — so only that is kept.
 */
export function toTraceSteps(steps: AgentRunStep[]): AgentRunTraceStep[] {
  return steps.map((step) => ({
    index: step.index,
    thought: step.thought,
    tools: step.toolResults.map((tool) => ({
      name: tool.name,
      ok: tool.ok,
      durationMs: tool.durationMs,
      ...(tool.error === undefined ? {} : { error: tool.error }),
    })),
  }));
}

export class InMemoryAgentRunStore implements AgentRunStore {
  readonly #runs = new Map<string, AgentRunRecord>();

  constructor(private readonly capacity = 200) {}

  async start(run: AgentRunStart): Promise<void> {
    this.#runs.set(run.runId, {
      runId: run.runId,
      agentId: run.agentId,
      input: run.input,
      ...(run.sessionId === undefined ? {} : { sessionId: run.sessionId }),
      status: "running",
      steps: [],
      startedAt: run.startedAt ?? new Date().toISOString(),
    });
    this.#trim();
  }

  async complete(result: AgentRunResult): Promise<void> {
    this.#patch(result.runId, result.agentId, "", (existing) => ({
      ...existing,
      status: "completed",
      stoppedBecause: result.stoppedBecause,
      output: result.output,
      steps: toTraceSteps(result.steps),
      finishedAt: new Date().toISOString(),
      durationMs: result.durationMs,
    }));
  }

  async fail(runId: string, error: string): Promise<void> {
    const existing = this.#runs.get(runId);
    if (!existing) return;

    this.#runs.set(runId, {
      ...existing,
      status: "failed",
      error,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - Date.parse(existing.startedAt),
    });
  }

  async get(runId: string): Promise<AgentRunRecord | null> {
    const found = this.#runs.get(runId);
    return found ? { ...found } : null;
  }

  async recent(limit = 50, options: RecentAgentRunsOptions = {}): Promise<AgentRunRecord[]> {
    return [...this.#runs.values()]
      .filter((run) => (options.agentId ? run.agentId === options.agentId : true))
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
      .slice(0, limit)
      .map((run) => ({ ...run }));
  }

  /**
   * Applies a patch, creating a minimal record if `start` never landed.
   *
   * A persistence failure at start must not make the finished run invisible,
   * which would be a worse outcome than a record with a blank input.
   */
  #patch(runId: string, agentId: string, input: string, apply: (existing: AgentRunRecord) => AgentRunRecord): void {
    const existing = this.#runs.get(runId) ?? {
      runId,
      agentId,
      input,
      status: "running" as const,
      steps: [],
      startedAt: new Date().toISOString(),
    };

    this.#runs.set(runId, apply(existing));
    this.#trim();
  }

  /** Keeps the newest `capacity` runs; the oldest are the cheapest to drop. */
  #trim(): void {
    while (this.#runs.size > this.capacity) {
      const oldest = this.#runs.keys().next().value;
      if (oldest === undefined) break;
      this.#runs.delete(oldest);
    }
  }
}
