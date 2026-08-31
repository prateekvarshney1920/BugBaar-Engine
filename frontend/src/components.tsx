import type { ReactNode } from "react";
import { ApiError } from "./api/client.ts";

export function Card({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="card">
      <h2>{title}</h2>
      {hint ? <p className="hint">{hint}</p> : null}
      {children}
    </section>
  );
}

/** Renders an API failure with its code and request id, so logs can be correlated. */
export function ErrorBanner({ error }: { error: unknown }) {
  if (!error) return null;

  const detail =
    error instanceof ApiError
      ? `${error.code}: ${error.message}${error.requestId ? ` (request ${error.requestId})` : ""}`
      : error instanceof Error
        ? error.message
        : describeUnknown(error);

  return (
    <div className="banner error" role="alert">
      {detail}
    </div>
  );
}

/** Renders a non-Error throw without collapsing an object to "[object Object]". */
function describeUnknown(error: unknown): string {
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) ?? "Unknown error";
  } catch {
    return "Unknown error";
  }
}

export function Pill({ status }: { status: string }) {
  const tone =
    status === "ok" || status === "succeeded" || status === "completed" || status === "up"
      ? "ok"
      : status === "failed" || status === "error" || status === "down" || status === "aborted"
        ? "error"
        : status === "degraded" || status === "max_steps" || status === "not_configured"
          ? "warn"
          : status === "streaming" || status === "running"
            ? "streaming"
            : "";

  return <span className={`pill ${tone}`}>{status}</span>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}
