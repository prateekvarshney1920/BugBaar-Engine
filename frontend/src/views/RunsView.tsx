import { useCallback, useEffect, useState } from "react";
import type { AgentRunSummary, AgentSummary } from "@bugbaar/api";
import { api } from "../api/client.ts";
import {
  Badge,
  Card,
  Drawer,
  EmptyState,
  ErrorState,
  PageHeader,
  RowSkeleton,
  Status,
  Tabs,
  formatDuration,
  formatWhen,
  toneOf,
} from "../components.tsx";
import { Icon } from "../icons.tsx";

type StatusFilter = "all" | "completed" | "failed" | "running";

/*
 * Agent run history — the observability surface over the persisted runs.
 *
 * Everything shown is a stored record: nothing is recomputed in the browser,
 * and a run that carries no trace says so rather than rendering an empty
 * timeline that implies the agent did nothing.
 */
export function RunsView() {
  const [runs, setRuns] = useState<AgentRunSummary[] | null>(null);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [agentFilter, setAgentFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [selected, setSelected] = useState<AgentRunSummary | null>(null);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const [runList, agentList] = await Promise.all([
        api.agentRuns({ limit: 100, ...(agentFilter ? { agentId: agentFilter } : {}) }),
        api.listAgents(),
      ]);
      setRuns(runList.runs);
      setAgents(agentList.agents);
      setError(null);
    } catch (caught) {
      setError(caught);
      setRuns([]);
    }
  }, [agentFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = (runs ?? []).filter((run) => statusFilter === "all" || run.status === statusFilter);

  return (
    <>
      <PageHeader
        title="Agent runs"
        description="Every execution is persisted with its step and tool trace, so a run can be inspected long after it finished."
        actions={
          <button className="btn ghost" onClick={() => void load()}>
            {Icon.refresh({ size: 14 })} Refresh
          </button>
        }
      />

      <ErrorState error={error} onRetry={() => void load()} />

      <div className="inline rise">
        <Tabs
          tabs={[
            { id: "all", label: "All" },
            { id: "completed", label: "Completed" },
            { id: "failed", label: "Failed" },
            { id: "running", label: "Running" },
          ]}
          value={statusFilter}
          onChange={setStatusFilter}
        />

        <div className="field" style={{ width: 190, marginLeft: "auto" }}>
          <select
            value={agentFilter}
            onChange={(event) => setAgentFilter(event.target.value)}
            aria-label="Filter by agent"
          >
            <option value="">All agents</option>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.id}
              </option>
            ))}
          </select>
        </div>
      </div>

      <Card flush className="rise">
        {runs === null ? (
          <RowSkeleton rows={6} />
        ) : visible.length === 0 ? (
          <div className="card-pad">
            <EmptyState
              icon={Icon.runs({ size: 18 })}
              title={runs.length === 0 ? "No runs recorded" : "No runs match these filters"}
              message={
                runs.length === 0
                  ? "Runs are stored as agents execute. Run one from the playground and its full trace will appear here."
                  : "Try a different status or agent, or clear the filters to see everything."
              }
              action={
                runs.length > 0 ? (
                  <button
                    className="btn ghost"
                    onClick={() => {
                      setStatusFilter("all");
                      setAgentFilter("");
                    }}
                  >
                    Clear filters
                  </button>
                ) : undefined
              }
            />
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Agent</th>
                  <th>Input</th>
                  <th>Steps</th>
                  <th>Duration</th>
                  <th>Started</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {visible.map((run) => (
                  <tr
                    key={run.runId}
                    className="clickable"
                    data-selected={selected?.runId === run.runId}
                    onClick={() => setSelected(run)}
                  >
                    <td>
                      <Status status={run.status} pulse={run.status === "running"} />
                    </td>
                    <td className="strong">{run.agentId}</td>
                    <td className="truncate" style={{ maxWidth: 260 }}>
                      {run.input || <span className="dim">—</span>}
                    </td>
                    <td className="mono">{run.steps.length}</td>
                    <td className="mono">{formatDuration(run.durationMs)}</td>
                    <td className="dim">{formatWhen(run.startedAt)}</td>
                    <td>{Icon.chevron({ size: 14 })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {selected ? <RunDetail run={selected} onClose={() => setSelected(null)} /> : null}
    </>
  );
}

/** The trace, read top to bottom: start → steps and tool calls → outcome. */
function RunDetail({ run, onClose }: { run: AgentRunSummary; onClose: () => void }) {
  const [full, setFull] = useState<AgentRunSummary>(run);

  // The list endpoint already returns the whole record, but re-fetching by id
  // keeps a drawer opened from a stale list showing current state.
  useEffect(() => {
    let cancelled = false;
    api
      .agentRun(run.runId)
      .then((fresh) => {
        if (!cancelled) setFull(fresh);
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [run.runId]);

  return (
    <Drawer title={`${full.agentId} run`} subtitle={<span className="mono">{full.runId}</span>} onClose={onClose}>
      <div className="inline">
        <Status status={full.status} pulse={full.status === "running"} />
        <Badge mono>{formatDuration(full.durationMs)}</Badge>
        {full.stoppedBecause ? <Badge tone={toneOf(full.stoppedBecause)}>{full.stoppedBecause}</Badge> : null}
        {full.sessionId ? <Badge mono>session {full.sessionId}</Badge> : null}
      </div>

      <div>
        <div className="dim" style={{ marginBottom: 6 }}>
          Input
        </div>
        <pre>{full.input || "(empty)"}</pre>
      </div>

      <div>
        <div className="dim" style={{ marginBottom: 10 }}>
          Execution trace
        </div>

        <div className="timeline">
          <TraceNode
            tone="accent"
            icon={Icon.play({ size: 11 })}
            title="Run started"
            meta={formatWhen(full.startedAt)}
          />

          {full.steps.map((step) => (
            <div key={step.index}>
              <TraceNode
                tone="neutral"
                icon={
                  <span className="mono" style={{ fontSize: 10 }}>
                    {step.index + 1}
                  </span>
                }
                title={`Step ${step.index + 1}`}
                meta={step.thought || undefined}
              />
              {step.tools.map((tool, toolIndex) => (
                <TraceNode
                  key={`${tool.name}-${toolIndex}`}
                  tone={tool.ok ? "ok" : "danger"}
                  icon={Icon.tool({ size: 11 })}
                  title={
                    <>
                      <span className="mono">{tool.name}</span>
                      <Badge tone={tool.ok ? "ok" : "danger"}>{tool.ok ? "ok" : "failed"}</Badge>
                      <span className="mono dim">{formatDuration(tool.durationMs)}</span>
                    </>
                  }
                  meta={tool.error}
                />
              ))}
            </div>
          ))}

          {full.status === "running" ? (
            <TraceNode tone="live" icon={<span className="dot pulse" />} title="Still executing" />
          ) : full.status === "failed" ? (
            <TraceNode tone="danger" icon={Icon.x({ size: 11 })} title="Failed" meta={full.error} />
          ) : (
            <TraceNode
              tone="ok"
              icon={Icon.check({ size: 11 })}
              title="Completed"
              meta={full.finishedAt ? formatWhen(full.finishedAt) : undefined}
            />
          )}
        </div>
      </div>

      {full.output ? (
        <div>
          <div className="dim" style={{ marginBottom: 6 }}>
            Output
          </div>
          <pre>{full.output}</pre>
        </div>
      ) : null}

      {full.steps.length === 0 && full.status === "completed" ? (
        <p className="dim" style={{ margin: 0 }}>
          This run answered directly without calling any tools, so the trace has no intermediate steps.
        </p>
      ) : null}
    </Drawer>
  );
}

function TraceNode({
  tone,
  icon,
  title,
  meta,
}: {
  tone: "neutral" | "accent" | "live" | "ok" | "danger";
  icon: React.ReactNode;
  title: React.ReactNode;
  meta?: string;
}) {
  return (
    <div className="tl-item">
      <span className={`tl-node ${tone === "neutral" ? "" : tone}`.trim()}>{icon}</span>
      <div className="tl-body">
        <div className="tl-title">{title}</div>
        {meta ? <div className="muted">{meta}</div> : null}
      </div>
    </div>
  );
}
