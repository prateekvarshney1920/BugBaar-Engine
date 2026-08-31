export type StepStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";

export interface RetryPolicy {
  maxAttempts: number;
  /** Delay before the first retry, doubled on each subsequent attempt. */
  backoffMs: number;
  maxBackoffMs?: number;
}

export interface StepContext<TInput = unknown> {
  input: TInput;
  /** Outputs of previously completed steps, keyed by step name. */
  results: Record<string, unknown>;
  runId: string;
  attempt: number;
  signal?: AbortSignal;
  /** Declared as a property, not a method, so destructuring it stays safe. */
  log: (message: string, data?: Record<string, unknown>) => void;
}

export interface WorkflowStep<TInput = unknown, TOutput = unknown> {
  name: string;
  description?: string;
  run(context: StepContext<TInput>): Promise<TOutput>;
  /** Return false to skip this step; previous results are available. */
  when?(context: StepContext<TInput>): boolean | Promise<boolean>;
  retry?: RetryPolicy;
  timeoutMs?: number;
  /** Run despite an earlier failure — for cleanup and notification steps. */
  alwaysRun?: boolean;
}

export interface StepRecord {
  name: string;
  status: StepStatus;
  attempts: number;
  output?: unknown;
  error?: string;
  startedAt: string;
  durationMs: number;
}

export interface WorkflowRun {
  runId: string;
  workflow: string;
  status: "succeeded" | "failed" | "aborted";
  steps: StepRecord[];
  results: Record<string, unknown>;
  error?: string;
  startedAt: string;
  durationMs: number;
}

export interface WorkflowLogEntry {
  runId: string;
  step: string;
  message: string;
  data?: Record<string, unknown>;
  at: string;
}
