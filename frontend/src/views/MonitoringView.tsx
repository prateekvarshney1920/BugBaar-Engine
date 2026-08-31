import { useEffect, useState } from "react";
import type { HealthResponse } from "@bugbaar/api";
import { api } from "../api/client.ts";
import { Card, ErrorBanner, Pill } from "../components.tsx";

const POLL_INTERVAL_MS = 10_000;

export function MonitoringView() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let cancelled = false;

    const poll = (): void => {
      api
        .health()
        .then((response) => {
          if (cancelled) return;
          setHealth(response);
          setError(null);
        })
        .catch((caught: unknown) => {
          if (!cancelled) setError(caught);
        });
    };

    poll();
    const timer = setInterval(poll, POLL_INTERVAL_MS);

    // Stop polling on unmount so a backgrounded tab is not still hitting the API.
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return (
    <div className="stack">
      <ErrorBanner error={error} />

      <Card title="Engine status" hint={`Polled every ${POLL_INTERVAL_MS / 1000} seconds.`}>
        {health ? (
          <>
            <div className="row" style={{ gap: 16, marginBottom: 18 }}>
              <Pill status={health.status} />
              <span className="muted">version {health.version}</span>
              <span className="muted">up {formatUptime(health.uptimeSeconds)}</span>
            </div>

            <table>
              <thead>
                <tr>
                  <th>Dependency</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(health.dependencies).map(([name, status]) => (
                  <tr key={name}>
                    <td>
                      <code>{name}</code>
                    </td>
                    <td>
                      <Pill status={status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <p className="muted" style={{ marginTop: 16 }}>
              <code>not_configured</code> means the engine is running on its in-memory fallback for that dependency —
              fine for development, lost on restart.
            </p>
          </>
        ) : (
          <p className="muted">Loading…</p>
        )}
      </Card>
    </div>
  );
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  const hours = Math.floor(seconds / 3600);
  return `${hours}h ${Math.floor((seconds % 3600) / 60)}m`;
}
