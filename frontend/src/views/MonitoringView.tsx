import { useCallback, useEffect, useState } from "react";
import type { HealthResponse } from "@bugbaar/api";
import { api, sumMetric, type PrometheusSample } from "../api/client.ts";
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  Metric,
  MetricSkeleton,
  PageHeader,
  Status,
  formatDuration,
  formatNumber,
} from "../components.tsx";
import { Icon } from "../icons.tsx";

const POLL_MS = 10_000;

/*
 * Observability, read from the engine's own Prometheus endpoint.
 *
 * Nothing here is synthesised. There is no time-series chart because the
 * engine exposes point-in-time counters, not history — a line chart would be
 * inventing shape that no data supports. Distributions that do exist, such as
 * per-tool counts, are drawn as real proportions.
 */
export function MonitoringView() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [samples, setSamples] = useState<PrometheusSample[] | null>(null);
  const [metricsOff, setMetricsOff] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      setHealth(await api.health());
      setError(null);
    } catch (caught) {
      setError(caught);
      return;
    }

    try {
      setSamples(await api.metrics());
      setMetricsOff(false);
    } catch {
      // METRICS_ENABLED=false removes the route; that is configuration, not a
      // failure, so it gets an explanation rather than an error banner.
      setMetricsOff(true);
      setSamples(null);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const value = (name: string, where: Record<string, string> = {}): number | null =>
    samples ? sumMetric(samples, name, where) : null;

  const httpTotal = value("bugbaar_http_requests_total");
  const httpDurationSum = value("bugbaar_http_request_duration_seconds_sum");
  const httpDurationCount = value("bugbaar_http_request_duration_seconds_count");
  const avgHttp =
    httpDurationSum !== null && httpDurationCount !== null && httpDurationCount > 0
      ? formatDuration((httpDurationSum / httpDurationCount) * 1000)
      : null;

  const toolSamples = (samples ?? []).filter((sample) => sample.name === "bugbaar_tool_calls_total");
  const byTool = new Map<string, number>();
  for (const sample of toolSamples) {
    const tool = sample.labels.tool ?? "unknown";
    byTool.set(tool, (byTool.get(tool) ?? 0) + sample.value);
  }
  const toolMax = Math.max(1, ...byTool.values());

  const routeSamples = (samples ?? []).filter((sample) => sample.name === "bugbaar_http_requests_total");
  const byRoute = new Map<string, number>();
  for (const sample of routeSamples) {
    const route = `${sample.labels.method ?? ""} ${sample.labels.route ?? ""}`.trim();
    byRoute.set(route, (byRoute.get(route) ?? 0) + sample.value);
  }
  const topRoutes = [...byRoute.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  const routeMax = Math.max(1, ...topRoutes.map(([, count]) => count));

  return (
    <>
      <PageHeader
        title="Monitoring"
        description={`Live counters from the engine's Prometheus endpoint, polled every ${POLL_MS / 1000} seconds.`}
        actions={
          <button className="btn ghost" onClick={() => void load()}>
            {Icon.refresh({ size: 14 })} Refresh
          </button>
        }
      />

      <ErrorState error={error} onRetry={() => void load()} />

      <Card title="Dependencies" className="rise">
        {health ? (
          <div className="stack" style={{ gap: 10 }}>
            <div className="inline">
              <Status status={health.status} />
              <Badge mono>v{health.version}</Badge>
              <Badge mono>up {Math.floor(health.uptimeSeconds / 60)}m</Badge>
            </div>
            <div className="grid metrics">
              {Object.entries(health.dependencies).map(([name, state]) => (
                <div className="metric" key={name}>
                  <div className="metric-top">
                    <span className="metric-icon">{Icon.database({ size: 13 })}</span>
                    {name}
                  </div>
                  <Status status={state} />
                </div>
              ))}
            </div>
          </div>
        ) : (
          <MetricSkeleton count={4} />
        )}
      </Card>

      {metricsOff ? (
        <Card>
          <EmptyState
            icon={Icon.monitoring({ size: 18 })}
            title="Metrics endpoint unavailable"
            message="The engine exposes /metrics unless METRICS_ENABLED=false. Health above is still live."
          />
        </Card>
      ) : samples === null ? (
        <MetricSkeleton count={4} />
      ) : (
        <>
          <div className="grid metrics">
            <Metric
              label="HTTP requests"
              value={httpTotal === null ? null : formatNumber(httpTotal)}
              foot={avgHttp ? `${avgHttp} average` : undefined}
              icon={Icon.developer({ size: 14 })}
              accent="accent"
            />
            <Metric
              label="Agent runs"
              value={(() => {
                const total = value("bugbaar_agent_runs_total");
                return total === null ? null : formatNumber(total);
              })()}
              foot={(() => {
                const active = value("bugbaar_agent_runs_active");
                return active !== null && active > 0 ? `${active} executing` : "None executing";
              })()}
              icon={Icon.agents({ size: 14 })}
            />
            <Metric
              label="Workflow runs"
              value={(() => {
                const total = value("bugbaar_workflow_runs_total");
                return total === null ? null : formatNumber(total);
              })()}
              foot={(() => {
                const failed = value("bugbaar_workflow_runs_total", { status: "failed" });
                return failed !== null && failed > 0 ? `${formatNumber(failed)} failed` : "No failures";
              })()}
              icon={Icon.workflows({ size: 14 })}
            />
            <Metric
              label="Open streams"
              value={value("bugbaar_streams_active")}
              foot="Server-sent event connections"
              icon={Icon.bolt({ size: 14 })}
              accent="live"
            />
            <Metric
              label="Jobs enqueued"
              value={(() => {
                const total = value("bugbaar_jobs_enqueued_total");
                return total === null ? null : formatNumber(total);
              })()}
              foot="Background workflow jobs"
              icon={Icon.queue({ size: 14 })}
            />
            <Metric
              label="Rate limited"
              value={(() => {
                const total = value("bugbaar_rate_limited_total");
                return total === null ? null : formatNumber(total);
              })()}
              foot="Requests refused by the limiter"
              icon={Icon.alert({ size: 14 })}
            />
          </div>

          <div className="split">
            <Card title="Requests by route" className="rise">
              {topRoutes.length === 0 ? (
                <EmptyState
                  icon={Icon.developer({ size: 18 })}
                  title="No requests recorded"
                  message="Route counters appear once the API has served traffic."
                />
              ) : (
                <div className="stack" style={{ gap: 9 }}>
                  {topRoutes.map(([route, count]) => (
                    <div key={route}>
                      <div className="inline" style={{ justifyContent: "space-between" }}>
                        <span className="mono truncate">{route}</span>
                        <span className="mono dim">{formatNumber(count)}</span>
                      </div>
                      <div className="meter" aria-hidden="true">
                        <span style={{ width: `${(count / routeMax) * 100}%` }} />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <Card title="Tool calls" className="rise">
              {byTool.size === 0 ? (
                <EmptyState
                  icon={Icon.tool({ size: 18 })}
                  title="No tool calls yet"
                  message="Counters appear the first time an agent invokes a tool."
                />
              ) : (
                <div className="stack" style={{ gap: 9 }}>
                  {[...byTool.entries()]
                    .sort((a, b) => b[1] - a[1])
                    .map(([tool, count]) => (
                      <div key={tool}>
                        <div className="inline" style={{ justifyContent: "space-between" }}>
                          <span className="mono">{tool}</span>
                          <span className="mono dim">{formatNumber(count)}</span>
                        </div>
                        <div className="meter ok" aria-hidden="true">
                          <span style={{ width: `${(count / toolMax) * 100}%` }} />
                        </div>
                      </div>
                    ))}
                </div>
              )}
            </Card>
          </div>

          <Card title="Process" className="rise">
            <div className="grid metrics">
              <Metric
                label="Heap used"
                value={(() => {
                  const bytes = value("bugbaar_nodejs_heap_size_used_bytes");
                  return bytes === null ? null : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
                })()}
                icon={Icon.database({ size: 14 })}
              />
              <Metric
                label="Resident memory"
                value={(() => {
                  const bytes = value("bugbaar_process_resident_memory_bytes");
                  return bytes === null ? null : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
                })()}
                icon={Icon.database({ size: 14 })}
              />
              <Metric
                label="CPU time"
                value={(() => {
                  const seconds = value("bugbaar_process_cpu_seconds_total");
                  return seconds === null ? null : `${seconds.toFixed(2)}s`;
                })()}
                icon={Icon.bolt({ size: 14 })}
              />
              <Metric
                label="Open handles"
                value={value("bugbaar_nodejs_active_handles_total")}
                icon={Icon.panel({ size: 14 })}
              />
            </div>
          </Card>
        </>
      )}
    </>
  );
}
