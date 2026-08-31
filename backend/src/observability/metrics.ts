import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from "@prometheus-io/client";

/**
 * Prometheus instrumentation for the engine.
 *
 * Every metric here answers a question an operator actually asks during an
 * incident — is it slow, is it failing, is the queue backing up, are we being
 * throttled — rather than counting whatever happened to be easy to count.
 *
 * Label cardinality is kept deliberately low. Agent id, workflow name, and
 * tool name are bounded by configuration; run ids and session ids are not, and
 * putting them on a label would create a new time series per request and
 * eventually take out the Prometheus server. Those belong in the run records
 * and logs, which are queried by id rather than aggregated.
 */
export class Metrics {
  readonly registry = new Registry();

  readonly httpRequests: Counter<"method" | "route" | "status">;
  readonly httpDuration: Histogram<"method" | "route">;

  readonly agentRuns: Counter<"agent" | "outcome">;
  readonly agentRunDuration: Histogram<"agent">;
  readonly agentSteps: Histogram<"agent">;
  readonly agentRunsActive: Gauge<string>;

  readonly toolCalls: Counter<"tool" | "outcome">;
  readonly toolDuration: Histogram<"tool">;

  readonly workflowRuns: Counter<"workflow" | "status">;
  readonly workflowDuration: Histogram<"workflow">;
  readonly workflowStepFailures: Counter<"workflow" | "step">;

  readonly jobsEnqueued: Counter<"workflow">;
  readonly streamsActive: Gauge<string>;
  readonly rateLimited: Counter<"scope">;

  constructor(options: { defaultMetrics?: boolean } = {}) {
    const registers = [this.registry];

    this.httpRequests = new Counter({
      name: "bugbaar_http_requests_total",
      help: "HTTP requests by method, route template, and status class.",
      labelNames: ["method", "route", "status"],
      registers,
    });

    this.httpDuration = new Histogram({
      name: "bugbaar_http_request_duration_seconds",
      help: "HTTP request duration.",
      labelNames: ["method", "route"],
      // Tuned for an API that both serves fast reads and proxies model calls.
      buckets: [0.005, 0.025, 0.1, 0.5, 1, 2.5, 5, 10, 30],
      registers,
    });

    this.agentRuns = new Counter({
      name: "bugbaar_agent_runs_total",
      help: "Agent runs by agent and outcome (completed, max_steps, aborted, error).",
      labelNames: ["agent", "outcome"],
      registers,
    });

    this.agentRunDuration = new Histogram({
      name: "bugbaar_agent_run_duration_seconds",
      help: "Wall-clock duration of an agent run.",
      labelNames: ["agent"],
      buckets: [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120],
      registers,
    });

    this.agentSteps = new Histogram({
      name: "bugbaar_agent_run_steps",
      help: "Reasoning steps taken per run. A rising tail means agents are looping.",
      labelNames: ["agent"],
      buckets: [1, 2, 3, 5, 8, 12, 16, 24, 32],
      registers,
    });

    this.agentRunsActive = new Gauge({
      name: "bugbaar_agent_runs_active",
      help: "Agent runs currently executing.",
      registers,
    });

    this.toolCalls = new Counter({
      name: "bugbaar_tool_calls_total",
      help: "Tool invocations by tool and outcome.",
      labelNames: ["tool", "outcome"],
      registers,
    });

    this.toolDuration = new Histogram({
      name: "bugbaar_tool_call_duration_seconds",
      help: "Tool execution duration.",
      labelNames: ["tool"],
      buckets: [0.001, 0.01, 0.05, 0.25, 1, 5, 15],
      registers,
    });

    this.workflowRuns = new Counter({
      name: "bugbaar_workflow_runs_total",
      help: "Workflow runs by workflow and final status.",
      labelNames: ["workflow", "status"],
      registers,
    });

    this.workflowDuration = new Histogram({
      name: "bugbaar_workflow_run_duration_seconds",
      help: "Workflow run duration.",
      labelNames: ["workflow"],
      buckets: [0.05, 0.25, 1, 5, 15, 60, 300],
      registers,
    });

    this.workflowStepFailures = new Counter({
      name: "bugbaar_workflow_step_failures_total",
      help: "Failed workflow steps, labelled by step so the culprit is obvious.",
      labelNames: ["workflow", "step"],
      registers,
    });

    this.jobsEnqueued = new Counter({
      name: "bugbaar_jobs_enqueued_total",
      help: "Workflow jobs queued for background execution.",
      labelNames: ["workflow"],
      registers,
    });

    this.streamsActive = new Gauge({
      name: "bugbaar_streams_active",
      help: "Open server-sent-event streams.",
      registers,
    });

    this.rateLimited = new Counter({
      name: "bugbaar_rate_limited_total",
      help: "Requests refused by the rate limiter, by limiter scope.",
      labelNames: ["scope"],
      registers,
    });

    // Process, heap, and event-loop-lag metrics. Cheap, and the first thing
    // worth looking at when the API is slow but nothing is obviously failing.
    if (options.defaultMetrics !== false) {
      collectDefaultMetrics({ register: this.registry, prefix: "bugbaar_" });
    }
  }

  /** Records a finished workflow run, including which step failed. */
  observeWorkflowRun(run: {
    workflow: string;
    status: string;
    durationMs: number;
    steps: { name: string; status: string }[];
  }): void {
    this.workflowRuns.inc({ workflow: run.workflow, status: run.status });
    this.workflowDuration.observe({ workflow: run.workflow }, run.durationMs / 1000);

    for (const step of run.steps) {
      if (step.status === "failed") {
        this.workflowStepFailures.inc({ workflow: run.workflow, step: step.name });
      }
    }
  }

  /** Renders the current values in Prometheus text exposition format. */
  async render(): Promise<{ contentType: string; body: string }> {
    return { contentType: this.registry.contentType, body: await this.registry.metrics() };
  }
}
