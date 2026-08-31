import type { RetryPolicy, StepContext, StepRecord, WorkflowLogEntry, WorkflowRun, WorkflowStep } from "./types.js";

export interface WorkflowOptions<TInput> {
  name: string;
  description?: string;
  steps: WorkflowStep<TInput>[];
  /** Applied to steps that don't define their own policy. */
  defaultRetry?: RetryPolicy;
  onLog?: (entry: WorkflowLogEntry) => void;
}

export interface ExecuteOptions {
  runId?: string;
  signal?: AbortSignal;
  onStep?: (record: StepRecord) => void;
}

/**
 * Sequential workflow executor with per-step retries, timeouts, and
 * conditional execution.
 *
 * Steps run in order and read each other's outputs through `context.results`.
 * A failure stops the run, except for steps marked `alwaysRun` — those still
 * execute so cleanup and alerting are not skipped.
 */
export class Workflow<TInput = unknown> {
  readonly name: string;
  readonly description?: string;
  readonly #steps: WorkflowStep<TInput>[];
  readonly #defaultRetry: RetryPolicy;
  readonly #onLog?: (entry: WorkflowLogEntry) => void;

  constructor(options: WorkflowOptions<TInput>) {
    if (options.steps.length === 0) throw new Error(`Workflow "${options.name}" has no steps`);

    const names = new Set<string>();
    for (const step of options.steps) {
      if (names.has(step.name)) throw new Error(`Duplicate step name "${step.name}" in workflow "${options.name}"`);
      names.add(step.name);
    }

    this.name = options.name;
    this.description = options.description;
    this.#steps = options.steps;
    this.#defaultRetry = options.defaultRetry ?? { maxAttempts: 1, backoffMs: 500 };
    this.#onLog = options.onLog;
  }

  get steps(): readonly WorkflowStep<TInput>[] {
    return this.#steps;
  }

  async execute(input: TInput, options: ExecuteOptions = {}): Promise<WorkflowRun> {
    const runId = options.runId ?? crypto.randomUUID();
    const startedAt = new Date().toISOString();
    const start = performance.now();

    const results: Record<string, unknown> = {};
    const records: StepRecord[] = [];
    let failure: Error | undefined;
    let aborted = false;

    for (const step of this.#steps) {
      const skip = (failure !== undefined || aborted) && !step.alwaysRun;
      if (skip) {
        records.push(this.#skipped(step.name));
        continue;
      }

      if (options.signal?.aborted) {
        aborted = true;
        records.push(this.#skipped(step.name));
        continue;
      }

      const record = await this.#runStep(step, { input, results, runId, signal: options.signal });
      records.push(record);
      options.onStep?.(record);

      if (record.status === "succeeded") {
        results[step.name] = record.output;
      } else if (record.status === "failed" && failure === undefined) {
        failure = new Error(`Step "${step.name}" failed: ${record.error}`);
      }
    }

    return {
      runId,
      workflow: this.name,
      status: aborted ? "aborted" : failure ? "failed" : "succeeded",
      steps: records,
      results,
      error: failure?.message,
      startedAt,
      durationMs: Math.round(performance.now() - start),
    };
  }

  async #runStep(
    step: WorkflowStep<TInput>,
    base: { input: TInput; results: Record<string, unknown>; runId: string; signal?: AbortSignal },
  ): Promise<StepRecord> {
    const startedAt = new Date().toISOString();
    const start = performance.now();
    const policy = step.retry ?? this.#defaultRetry;
    const maxBackoff = policy.maxBackoffMs ?? 30_000;

    const makeContext = (attempt: number): StepContext<TInput> => ({
      ...base,
      attempt,
      log: (message, data) =>
        this.#onLog?.({ runId: base.runId, step: step.name, message, data, at: new Date().toISOString() }),
    });

    if (step.when && !(await step.when(makeContext(1)))) {
      return { name: step.name, status: "skipped", attempts: 0, startedAt, durationMs: 0 };
    }

    let lastError = "";

    for (let attempt = 1; attempt <= Math.max(1, policy.maxAttempts); attempt += 1) {
      try {
        const output = await this.#withTimeout(step, makeContext(attempt));
        return {
          name: step.name,
          status: "succeeded",
          attempts: attempt,
          output,
          startedAt,
          durationMs: Math.round(performance.now() - start),
        };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        const hasAttemptsLeft = attempt < policy.maxAttempts;
        if (!hasAttemptsLeft || base.signal?.aborted) break;

        const delay = Math.min(policy.backoffMs * 2 ** (attempt - 1), maxBackoff);
        this.#onLog?.({
          runId: base.runId,
          step: step.name,
          message: `Attempt ${attempt} failed, retrying in ${delay}ms`,
          data: { error: lastError },
          at: new Date().toISOString(),
        });
        await sleep(delay, base.signal);
      }
    }

    return {
      name: step.name,
      status: "failed",
      attempts: policy.maxAttempts,
      error: lastError,
      startedAt,
      durationMs: Math.round(performance.now() - start),
    };
  }

  async #withTimeout(step: WorkflowStep<TInput>, context: StepContext<TInput>): Promise<unknown> {
    if (!step.timeoutMs) return step.run(context);

    const timeout = AbortSignal.timeout(step.timeoutMs);
    const signal = context.signal ? AbortSignal.any([context.signal, timeout]) : timeout;

    return Promise.race([
      step.run({ ...context, signal }),
      new Promise<never>((_, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new Error(`Step "${step.name}" timed out after ${step.timeoutMs}ms`)),
          {
            once: true,
          },
        );
      }),
    ]);
  }

  #skipped(name: string): StepRecord {
    return { name, status: "skipped", attempts: 0, startedAt: new Date().toISOString(), durationMs: 0 };
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
