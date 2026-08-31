import { useEffect, useState } from "react";
import type { WorkflowSummary } from "@bugbaar/api";
import { api, type WorkflowRun } from "../api/client.ts";
import { Card, Empty, ErrorBanner, formatDuration, Pill } from "../components.tsx";

export function WorkflowsView() {
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [selected, setSelected] = useState("");
  const [input, setInput] = useState(
    '{\n  "id": "notes",\n  "text": "BugBaar Engine is open-source AI infrastructure."\n}',
  );
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [running, setRunning] = useState(false);

  const refresh = async (): Promise<void> => {
    try {
      const [list, history] = await Promise.all([api.listWorkflows(), api.workflowRuns()]);
      setWorkflows(list.workflows);
      setRuns(history.runs);
      setSelected((current) => current || list.workflows[0]?.name || "");
      setError(null);
    } catch (caught) {
      setError(caught);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const run = async (): Promise<void> => {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(input) as Record<string, unknown>;
    } catch {
      setError(new Error("Input must be valid JSON"));
      return;
    }

    setRunning(true);
    try {
      await api.runWorkflow(selected, parsed);
      setError(null);
      await refresh();
    } catch (caught) {
      setError(caught);
    } finally {
      setRunning(false);
    }
  };

  const definition = workflows.find((workflow) => workflow.name === selected);

  return (
    <div className="stack">
      <ErrorBanner error={error} />

      <Card title="Run a workflow" hint="Input is passed to the first step as the workflow's context.">
        <div className="row">
          <div className="field">
            <label htmlFor="wf-name">Workflow</label>
            <select id="wf-name" value={selected} onChange={(event) => setSelected(event.target.value)}>
              {workflows.length === 0 ? <option value="">No workflows registered</option> : null}
              {workflows.map((workflow) => (
                <option key={workflow.name} value={workflow.name}>
                  {workflow.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        {definition ? (
          <p className="muted" style={{ marginTop: 10 }}>
            {definition.description} · Steps: {definition.steps.map((step) => step.name).join(" → ")}
          </p>
        ) : null}

        <div className="field" style={{ marginTop: 12 }}>
          <label htmlFor="wf-input">Input (JSON)</label>
          <textarea id="wf-input" value={input} onChange={(event) => setInput(event.target.value)} />
        </div>

        <div style={{ marginTop: 12 }}>
          <button className="action" onClick={() => void run()} disabled={running || !selected}>
            {running ? "Running…" : "Run workflow"}
          </button>
        </div>
      </Card>

      <Card title={`Recent runs (${runs.length})`}>
        {runs.length === 0 ? (
          <Empty>No runs yet.</Empty>
        ) : (
          <div className="stack">
            {runs.map((entry) => (
              <div key={entry.runId} className="step succeeded" style={{ borderColor: "var(--border)" }}>
                <div className="row" style={{ gap: 12 }}>
                  <strong>{entry.workflow}</strong>
                  <Pill status={entry.status} />
                  <span className="muted">{formatDuration(entry.durationMs)}</span>
                  <span className="muted">{new Date(entry.startedAt).toLocaleTimeString()}</span>
                </div>

                {entry.error ? (
                  <div className="banner error" style={{ marginTop: 8 }}>
                    {entry.error}
                  </div>
                ) : null}

                <div style={{ marginTop: 8 }}>
                  {entry.steps.map((step) => (
                    <div key={step.name} className={`step ${step.status}`} style={{ marginBottom: 6 }}>
                      <div className="row" style={{ gap: 10 }}>
                        <code>{step.name}</code>
                        <Pill status={step.status} />
                        {step.attempts > 1 ? <span className="muted">{step.attempts} attempts</span> : null}
                        <span className="muted">{formatDuration(step.durationMs)}</span>
                      </div>
                      {step.error ? (
                        <div className="muted" style={{ color: "var(--error)" }}>
                          {step.error}
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
