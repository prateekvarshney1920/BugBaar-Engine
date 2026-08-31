import { useCallback, useEffect, useState } from "react";
import type { WorkflowSummary } from "@bugbaar/api";
import { api, type WorkflowRun } from "../api/client.ts";
import {
  Badge,
  Card,
  Drawer,
  EmptyState,
  ErrorState,
  PageHeader,
  RowSkeleton,
  Status,
  formatDuration,
  formatWhen,
} from "../components.tsx";
import { Icon } from "../icons.tsx";

/*
 * Workflows: the registered definitions, a runner, and the persisted history.
 *
 * The step chain animates only while a run is actually in flight — an idle
 * workflow renders as a static diagram, because motion that does not track
 * real state is just noise.
 */
export function WorkflowsView() {
  const [workflows, setWorkflows] = useState<WorkflowSummary[] | null>(null);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [selected, setSelected] = useState("");
  const [input, setInput] = useState('{\n  "id": "notes",\n  "text": "BugBaar Engine is AI infrastructure."\n}');
  const [detail, setDetail] = useState<WorkflowRun | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [running, setRunning] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      const [list, history] = await Promise.all([api.listWorkflows(), api.workflowRuns()]);
      setWorkflows(list.workflows);
      setRuns(history.runs);
      setSelected((current) => current || list.workflows[0]?.name || "");
      setError(null);
    } catch (caught) {
      setError(caught);
      setWorkflows([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (): Promise<void> => {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(input) as Record<string, unknown>;
    } catch {
      setError(new Error("Input must be valid JSON."));
      return;
    }

    setRunning(true);
    try {
      await api.runWorkflow(selected, parsed);
      setError(null);
      await load();
    } catch (caught) {
      setError(caught);
    } finally {
      setRunning(false);
    }
  };

  const definition = workflows?.find((workflow) => workflow.name === selected);

  return (
    <>
      <PageHeader
        title="Workflows"
        description="Sequential steps with retries, timeouts, and cleanup that survives a failure. A failed run is recorded in full, not discarded."
        actions={
          <button className="btn ghost" onClick={() => void load()}>
            {Icon.refresh({ size: 14 })} Refresh
          </button>
        }
      />

      <ErrorState error={error} onRetry={() => void load()} />

      {workflows === null ? (
        <Card>
          <RowSkeleton rows={3} />
        </Card>
      ) : workflows.length === 0 ? (
        <Card>
          <EmptyState
            icon={Icon.workflows({ size: 18 })}
            title="No workflows registered"
            message="Workflows are registered in the backend at startup. None are currently available to run."
          />
        </Card>
      ) : (
        <div className="split">
          <Card title="Run a workflow" className="rise">
            <div className="stack">
              <div className="field">
                <label htmlFor="wf-name">Workflow</label>
                <select id="wf-name" value={selected} onChange={(event) => setSelected(event.target.value)}>
                  {workflows.map((workflow) => (
                    <option key={workflow.name} value={workflow.name}>
                      {workflow.name}
                    </option>
                  ))}
                </select>
              </div>

              {definition ? (
                <>
                  <p className="muted" style={{ margin: 0 }}>
                    {definition.description}
                  </p>
                  <StepChain steps={definition.steps.map((step) => step.name)} active={running} />
                </>
              ) : null}

              <div className="field">
                <label htmlFor="wf-input">Input (JSON)</label>
                <textarea id="wf-input" value={input} onChange={(event) => setInput(event.target.value)} />
              </div>

              <div>
                <button className="btn" onClick={() => void run()} disabled={running || !selected}>
                  {running ? "Running…" : "Run workflow"}
                </button>
              </div>
            </div>
          </Card>

          <Card title="Definition" className="rise">
            {definition ? (
              <div className="timeline">
                {definition.steps.map((step, index) => (
                  <div className="tl-item" key={step.name}>
                    <span className="tl-node">
                      <span className="mono" style={{ fontSize: 10 }}>
                        {index + 1}
                      </span>
                    </span>
                    <div className="tl-body">
                      <div className="tl-title mono">{step.name}</div>
                      {step.description ? <div className="muted">{step.description}</div> : null}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <span className="dim">Select a workflow.</span>
            )}
          </Card>
        </div>
      )}

      <Card title="Run history" flush className="rise" actions={<Badge mono>{runs.length}</Badge>}>
        {runs.length === 0 ? (
          <div className="card-pad">
            <EmptyState
              icon={Icon.inbox({ size: 18 })}
              title="No workflow runs yet"
              message="Run a workflow above and its per-step record — including retries and failures — appears here."
            />
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Workflow</th>
                  <th>Steps</th>
                  <th>Duration</th>
                  <th>Started</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {runs.map((entry) => (
                  <tr key={entry.runId} className="clickable" onClick={() => setDetail(entry)}>
                    <td>
                      <Status status={entry.status} />
                    </td>
                    <td className="strong">{entry.workflow}</td>
                    <td className="mono">{entry.steps.length}</td>
                    <td className="mono">{formatDuration(entry.durationMs)}</td>
                    <td className="dim">{formatWhen(entry.startedAt)}</td>
                    <td>{Icon.chevron({ size: 14 })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {detail ? (
        <Drawer
          title={detail.workflow}
          subtitle={<span className="mono">{detail.runId}</span>}
          onClose={() => setDetail(null)}
        >
          <div className="inline">
            <Status status={detail.status} />
            <Badge mono>{formatDuration(detail.durationMs)}</Badge>
          </div>

          {detail.error ? (
            <div className="banner error">
              <span style={{ marginTop: 2 }}>{Icon.alert({ size: 15 })}</span>
              <div>{detail.error}</div>
            </div>
          ) : null}

          <div>
            <div className="dim" style={{ marginBottom: 10 }}>
              Steps
            </div>
            <div className="timeline">
              {detail.steps.map((step) => (
                <div className="tl-item" key={step.name}>
                  <span
                    className={`tl-node ${
                      step.status === "succeeded" ? "ok" : step.status === "failed" ? "danger" : ""
                    }`.trim()}
                  >
                    {step.status === "succeeded"
                      ? Icon.check({ size: 11 })
                      : step.status === "failed"
                        ? Icon.x({ size: 11 })
                        : Icon.chevron({ size: 11 })}
                  </span>
                  <div className="tl-body">
                    <div className="tl-title">
                      <span className="mono">{step.name}</span>
                      <Status status={step.status} />
                      {step.attempts > 1 ? <Badge tone="warn">{step.attempts} attempts</Badge> : null}
                      <span className="mono dim">{formatDuration(step.durationMs)}</span>
                    </div>
                    {step.error ? (
                      <div className="muted" style={{ color: "var(--danger)" }}>
                        {step.error}
                      </div>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </Drawer>
      ) : null}
    </>
  );
}

/** Horizontal step chain; the moving highlight tracks a real in-flight run. */
function StepChain({ steps, active }: { steps: string[]; active: boolean }) {
  return (
    <div className="inline" style={{ gap: 0, flexWrap: "nowrap", overflowX: "auto", paddingBottom: 4 }}>
      {steps.map((step, index) => (
        <div className="inline" key={step} style={{ gap: 0, flexWrap: "nowrap" }}>
          <span className={`badge ${active ? "live" : ""} mono`.trim()} style={{ flexShrink: 0 }}>
            {active ? <span className="dot pulse" /> : null}
            {step}
          </span>
          {index < steps.length - 1 ? (
            <span
              aria-hidden="true"
              style={{
                width: 22,
                height: 1,
                flexShrink: 0,
                background: active ? "var(--live)" : "var(--border-strong)",
                opacity: active ? 0.8 : 1,
              }}
            />
          ) : null}
        </div>
      ))}
    </div>
  );
}
