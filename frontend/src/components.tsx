import { useEffect, useRef, type ReactNode } from "react";
import { ApiError } from "./api/client.ts";
import { Icon } from "./icons.tsx";

/*
 * The shared component vocabulary.
 *
 * Every page composes from these rather than styling its own cards, badges,
 * and states, so the interface stays one design rather than several.
 */

export function Card({
  title,
  hint,
  actions,
  flush,
  className = "",
  children,
}: {
  title?: string;
  hint?: string;
  actions?: ReactNode;
  flush?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={`card${flush ? " flush" : ""} ${className}`.trim()}>
      {title ? (
        <header className={`card-head${flush ? " card-pad" : ""}`}>
          <h3>{title}</h3>
          {actions ? <div className="actions">{actions}</div> : null}
        </header>
      ) : null}
      {hint ? <p className="hint">{hint}</p> : null}
      {children}
    </section>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="page-head rise">
      <div>
        <h2>{title}</h2>
        {description ? <p>{description}</p> : null}
      </div>
      {actions ? <div className="actions">{actions}</div> : null}
    </div>
  );
}

export type Tone = "neutral" | "ok" | "warn" | "danger" | "live" | "accent";

/** Maps a domain status onto a tone, so colour meaning stays consistent. */
export function toneOf(status: string): Tone {
  switch (status) {
    case "ok":
    case "up":
    case "succeeded":
    case "completed":
    case "true":
      return "ok";
    case "failed":
    case "error":
    case "down":
    case "aborted":
      return "danger";
    case "degraded":
    case "max_steps":
    case "not_configured":
    case "skipped":
      return "warn";
    case "running":
    case "streaming":
      return "live";
    default:
      return "neutral";
  }
}

/**
 * Status is carried by a label plus a dot shape, never by colour alone, so it
 * survives both greyscale and colour-vision differences.
 */
export function Status({ status, pulse }: { status: string; pulse?: boolean }) {
  const tone = toneOf(status);
  return (
    <span className={`badge ${tone === "neutral" ? "" : tone}`.trim()}>
      <span className={`dot${pulse ? " pulse" : ""}`} />
      {status.replace(/_/g, " ")}
    </span>
  );
}

export function Badge({ tone = "neutral", mono, children }: { tone?: Tone; mono?: boolean; children: ReactNode }) {
  return <span className={`badge ${tone === "neutral" ? "" : tone} ${mono ? "mono" : ""}`.trim()}>{children}</span>;
}

export function Metric({
  label,
  value,
  foot,
  icon,
  accent = "neutral",
}: {
  label: string;
  value: string | number | null;
  foot?: string;
  icon?: ReactNode;
  accent?: "neutral" | "accent" | "live" | "ok";
}) {
  // A null value means the backend has nothing to report, which is shown as
  // such rather than rendered as a zero that looks like a real measurement.
  const missing = value === null;

  return (
    <article className="metric rise">
      <div className="metric-top">
        {icon ? <span className={`metric-icon ${accent}`}>{icon}</span> : null}
        {label}
      </div>
      <div className={`metric-value${missing ? " pending" : ""}`}>{missing ? "No data" : value}</div>
      {foot ? <div className="metric-foot">{foot}</div> : null}
    </article>
  );
}

export function EmptyState({
  icon,
  title,
  message,
  action,
}: {
  icon?: ReactNode;
  title: string;
  message: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      {icon ? <span className="empty-icon">{icon}</span> : null}
      <h4>{title}</h4>
      <p>{message}</p>
      {action ? <div style={{ marginTop: 8 }}>{action}</div> : null}
    </div>
  );
}

/**
 * Renders a failure with its API error code and request id.
 *
 * Those two make a problem in the browser traceable to a line in the server
 * log, which is the difference between "it broke" and a diagnosis.
 */
export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (!error) return null;

  const detail =
    error instanceof ApiError
      ? { code: error.code, message: error.message, requestId: error.requestId }
      : {
          code: null,
          message: error instanceof Error ? error.message : describeUnknown(error),
          requestId: undefined,
        };

  return (
    <div className="banner error" role="alert">
      <span style={{ marginTop: 2 }}>{Icon.alert({ size: 15 })}</span>
      <div style={{ minWidth: 0 }}>
        <div className="strong">{detail.code ? `Request failed (${detail.code})` : "Something went wrong"}</div>
        <div style={{ opacity: 0.9 }}>{detail.message}</div>
        {detail.requestId ? <div className="mono dim">request {detail.requestId}</div> : null}
      </div>
      {onRetry ? (
        <div className="actions">
          <button className="btn ghost sm" onClick={onRetry}>
            Retry
          </button>
        </div>
      ) : null}
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

/** Skeletons mirror the layout they replace, so nothing shifts when data lands. */
export function Skeleton({
  height = 14,
  width = "100%",
  radius,
}: {
  height?: number;
  width?: string;
  radius?: number;
}) {
  return <div className="skel" style={{ height, width, borderRadius: radius }} />;
}

export function MetricSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid metrics">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="metric">
          <Skeleton height={12} width="45%" />
          <Skeleton height={26} width="60%" />
          <Skeleton height={10} width="35%" />
        </div>
      ))}
    </div>
  );
}

export function RowSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="stack card-pad">
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} height={30} />
      ))}
    </div>
  );
}

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: { id: T; label: string }[];
  value: T;
  onChange: (id: T) => void;
}) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((tab) => (
        <button key={tab.id} role="tab" aria-selected={tab.id === value} onClick={() => onChange(tab.id)}>
          {tab.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Right-hand drawer for detail views.
 *
 * Escape closes it and focus moves inside on open, so it is operable without a
 * mouse — the detail panes are where the densest technical content lives.
 */
export function Drawer({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    panel.current?.focus();

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={panel}>
        <header className="drawer-head">
          <div style={{ minWidth: 0 }}>
            <div className="strong truncate">{title}</div>
            {subtitle ? <div className="dim truncate">{subtitle}</div> : null}
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close" style={{ marginLeft: "auto" }}>
            {Icon.x({ size: 16 })}
          </button>
        </header>
        <div className="drawer-body">{children}</div>
      </aside>
    </>
  );
}

export function CodeBlock({ children }: { children: string }) {
  return <pre>{children}</pre>;
}

/** Formats a duration for display; sub-second values keep millisecond detail. */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/** Relative time, falling back to a date once an entry is older than a week. */
export function formatWhen(iso: string | undefined): string {
  if (!iso) return "—";

  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;

  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604_800) return `${Math.floor(seconds / 86_400)}d ago`;

  return new Date(then).toLocaleDateString();
}

export function formatNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}
