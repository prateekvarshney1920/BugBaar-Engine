import { useCallback, useEffect, useState } from "react";
import type { AgentRunSummary, AgentSummary, HealthResponse } from "@bugbaar/api";
import { api, sumMetric, type PrometheusSample } from "../api/client.ts";
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  Metric,
  MetricSkeleton,
  PageHeader,
  RowSkeleton,
  Status,
  formatDuration,
  formatNumber,
  formatWhen,
} from "../components.tsx";
import { Icon } from "../icons.tsx";

/*
 * The landing screen: what is happening inside the engine right now.
 *
 * Every figure here is read from the API. Where the backend has nothing to
 * report the card says "No data" rather than showing a zero, because a zero
 * reads as a measurement and would be a lie.
 */
export function OverviewView({
  onNavigate,
}: {
  onNavigate: (page: "agents" | "playground" | "runs" | "knowledge") => void;
}) {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [agents, setAgents] = useState<AgentSummary[] | null>(null);
  const [runs, setRuns] = useState<AgentRunSummary[] | null>(null);
  const [metrics, setMetrics] = useState<PrometheusSample[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      // Metrics are unauthenticated and may be disabled by configuration, so a
      // failure there must not blank the whole page.
      const [healthResult, agentList, runList] = await Promise.all([
        api.health(),
        api.listAgents(),
        api.agentRuns({ limit: 8 }),
      ]);

      setHealth(healthResult);
      setAgents(agentList.agents);
      setRuns(runList.runs);
      setError(null);

      setMetrics(await api.metrics().catch(() => null));
    } catch (caught) {
      setError(caught);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const completed = metrics && sumMetric(metrics, "bugbaar_agent_runs_total", { outcome: "completed" });
  const allRuns = metrics && sumMetric(metrics, "bugbaar_agent_runs_total");
  const toolCalls = metrics && sumMetric(metrics, "bugbaar_tool_calls_total");
  const activeRuns = metrics && sumMetric(metrics, "bugbaar_agent_runs_active");
  const durationSum = metrics && sumMetric(metrics, "bugbaar_agent_run_duration_seconds_sum");
  const durationCount = metrics && sumMetric(metrics, "bugbaar_agent_run_duration_seconds_count");

  const successRate =
    allRuns !== null && allRuns > 0 && completed !== null ? `${((completed / allRuns) * 100).toFixed(1)}%` : null;

  const averageRun =
    durationSum !== null && durationCount !== null && durationCount > 0
      ? formatDuration((durationSum / durationCount) * 1000)
      : null;

  return (
    <>
      <PageHeader
        title="Engine overview"
        description="Live state of the agent runtime, orchestration, and storage layers."
        actions={
          <>
            <button className="btn ghost" onClick={() => void load()}>
              {Icon.refresh({ size: 14 })} Refresh
            </button>
            <button className="btn" onClick={() => onNavigate("playground")}>
              {Icon.play({ size: 13 })} Run an agent
            </button>
          </>
        }
      />

      <ErrorState error={error} onRetry={() => void load()} />

      {loading && !health ? (
        <MetricSkeleton count={4} />
      ) : (
        <div className="grid metrics">
          <Metric
            label="Registered agents"
            value={agents ? agents.length : null}
            foot={
              agents?.length ? `${agents.filter((a) => a.tools.length > 0).length} with tools` : "None created yet"
            }
            icon={Icon.agents({ size: 14 })}
            accent="accent"
          />
          <Metric
            label="Agent runs"
            value={allRuns === null ? null : formatNumber(allRuns)}
            foot={activeRuns !== null && activeRuns > 0 ? `${activeRuns} executing now` : "Since last restart"}
            icon={Icon.runs({ size: 14 })}
            accent={activeRuns ? "live" : "neutral"}
          />
          <Metric
            label="Success rate"
            value={successRate}
            foot={completed !== null ? `${formatNumber(completed)} completed` : "Awaiting first run"}
            icon={Icon.check({ size: 14 })}
            accent="ok"
          />
          <Metric
            label="Average run time"
            value={averageRun}
            foot={toolCalls !== null ? `${formatNumber(toolCalls)} tool calls` : "No tool activity"}
            icon={Icon.bolt({ size: 14 })}
          />
        </div>
      )}

      <div className="split">
        <Card
          title="Recent agent runs"
          flush
          actions={
            <button className="btn quiet sm" onClick={() => onNavigate("runs")}>
              View all {Icon.chevron({ size: 13 })}
            </button>
          }
        >
          {loading && !runs ? (
            <RowSkeleton rows={4} />
          ) : runs && runs.length > 0 ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Agent</th>
                    <th>Run</th>
                    <th>Status</th>
                    <th>Duration</th>
                    <th>Started</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((run) => (
                    <tr key={run.runId}>
                      <td className="strong">{run.agentId}</td>
                      <td>
                        <span className="mono dim">{run.runId.slice(0, 8)}</span>
                      </td>
                      <td>
                        <Status status={run.status} pulse={run.status === "running"} />
                      </td>
                      <td className="mono">{formatDuration(run.durationMs)}</td>
                      <td className="dim">{formatWhen(run.startedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="card-pad">
              <EmptyState
                icon={Icon.runs({ size: 18 })}
                title="No runs recorded yet"
                message="Agent runs are persisted as they execute. Run an agent from the playground and it will appear here."
                action={
                  <button className="btn" onClick={() => onNavigate("playground")}>
                    Open playground
                  </button>
                }
              />
            </div>
          )}
        </Card>

        <div className="stack">
          <Card title="System health">
            {health ? (
              <div className="stack">
                <div className="inline">
                  <Status status={health.status} />
                  <span className="dim mono">v{health.version}</span>
                  <span className="dim" style={{ marginLeft: "auto" }}>
                    up {Math.floor(health.uptimeSeconds / 60)}m
                  </span>
                </div>

                <div className="stack" style={{ gap: 6 }}>
                  {Object.entries(health.dependencies).map(([name, state]) => (
                    <div className="inline" key={name} style={{ justifyContent: "space-between" }}>
                      <span className="mono muted">{name}</span>
                      <Status status={state} />
                    </div>
                  ))}
                </div>

                <p className="dim" style={{ margin: 0 }}>
                  <code>not configured</code> means the engine is running on its in-memory fallback for that
                  dependency — fine for development, lost on restart.
                </p>
              </div>
            ) : (
              <div className="stack">
                <div className="skel" style={{ height: 22 }} />
                <div className="skel" style={{ height: 60 }} />
              </div>
            )}
          </Card>

          <Card title="Quick actions">
            <div className="stack" style={{ gap: 6 }}>
              <button className="btn ghost" onClick={() => onNavigate("agents")}>
                {Icon.plus({ size: 13 })} Create an agent
              </button>
              <button className="btn ghost" onClick={() => onNavigate("knowledge")}>
                {Icon.knowledge({ size: 13 })} Ingest a document
              </button>
              <button className="btn ghost" onClick={() => onNavigate("runs")}>
                {Icon.runs({ size: 13 })} Inspect run traces
              </button>
            </div>
          </Card>
        </div>
      </div>

      {agents && agents.length > 0 ? (
        <Card title="Agents" actions={<Badge mono>{agents.length}</Badge>}>
          <div className="grid cards">
            {agents.slice(0, 6).map((agent) => (
              <div className="metric interactive" key={agent.id} onClick={() => onNavigate("agents")}>
                <div className="inline">
                  <span className="metric-icon accent">{Icon.agents({ size: 13 })}</span>
                  <span className="strong truncate">{agent.name}</span>
                </div>
                <div className="mono dim truncate">{agent.id}</div>
                <div className="inline">
                  {agent.tools.length > 0 ? (
                    agent.tools.map((tool) => (
                      <Badge key={tool} mono>
                        {tool}
                      </Badge>
                    ))
                  ) : (
                    <span className="dim">No tools granted</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </Card>
      ) : null}
    </>
  );
}
