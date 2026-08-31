import type { WorkflowRun } from "./types.js";

/**
 * Durable record of workflow executions.
 *
 * A failed run is as interesting as a successful one, so nothing is filtered
 * out here — the store keeps whatever `Workflow.execute()` produced.
 */
export interface WorkflowRunStore {
  record(run: WorkflowRun): Promise<void>;
  recent(limit?: number): Promise<WorkflowRun[]>;
  get(runId: string): Promise<WorkflowRun | null>;
}

export class InMemoryRunStore implements WorkflowRunStore {
  #runs: WorkflowRun[] = [];

  constructor(private readonly capacity = 100) {}

  async record(run: WorkflowRun): Promise<void> {
    // Newest first, so `recent()` is a slice rather than a sort.
    this.#runs.unshift(run);
    if (this.#runs.length > this.capacity) this.#runs.length = this.capacity;
  }

  async recent(limit = 50): Promise<WorkflowRun[]> {
    return this.#runs.slice(0, limit);
  }

  async get(runId: string): Promise<WorkflowRun | null> {
    return this.#runs.find((run) => run.runId === runId) ?? null;
  }
}
