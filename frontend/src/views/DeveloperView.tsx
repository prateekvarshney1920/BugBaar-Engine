import { useEffect, useState } from "react";
import { api } from "../api/client.ts";
import { Badge, Card, EmptyState, ErrorState, PageHeader, RowSkeleton, Tabs } from "../components.tsx";
import { Icon } from "../icons.tsx";

interface Tool {
  name: string;
  description: string;
  parameters: unknown;
}

/*
 * Developer reference.
 *
 * The tool catalogue is fetched live from /v1/tools, so the schemas shown are
 * the ones the engine will actually validate against rather than a copy that
 * can drift. The endpoint list is static product documentation, which is the
 * one thing on this screen that is not runtime data.
 */
const ENDPOINTS = [
  { method: "GET", path: "/health", note: "Status and dependency map. Unauthenticated." },
  { method: "GET", path: "/metrics", note: "Prometheus exposition. Unauthenticated." },
  { method: "GET", path: "/v1/agents", note: "List registered agents." },
  { method: "POST", path: "/v1/agents", note: "Create an agent from a definition." },
  { method: "DELETE", path: "/v1/agents/:id", note: "Remove an agent." },
  { method: "POST", path: "/v1/agents/:id/run", note: "Run an agent and wait for the result." },
  { method: "POST", path: "/v1/agents/:id/run/stream", note: "Run an agent over server-sent events." },
  { method: "GET", path: "/v1/agents/runs", note: "Persisted run history." },
  { method: "GET", path: "/v1/agents/runs/:runId", note: "One run with its full trace." },
  { method: "GET", path: "/v1/agents/:id/memory", note: "Conversation transcript for a session." },
  { method: "GET", path: "/v1/tools", note: "Tool catalogue with JSON schemas." },
  { method: "POST", path: "/v1/knowledge/documents", note: "Chunk, embed, and index documents." },
  { method: "POST", path: "/v1/knowledge/search", note: "Semantic retrieval over indexed chunks." },
  { method: "GET", path: "/v1/workflows", note: "Registered workflows and their steps." },
  { method: "POST", path: "/v1/workflows/:name/run", note: "Execute inline; 422 carries a failed run record." },
  { method: "POST", path: "/v1/workflows/:name/enqueue", note: "Queue for background execution." },
  { method: "GET", path: "/v1/schedules", note: "Repeating jobs and their next run time." },
];

const METHOD_TONE: Record<string, "ok" | "accent" | "danger" | "neutral"> = {
  GET: "ok",
  POST: "accent",
  DELETE: "danger",
};

export function DeveloperView() {
  const [tab, setTab] = useState<"tools" | "endpoints">("tools");
  const [tools, setTools] = useState<Tool[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    api
      .listTools()
      .then(({ tools: list }) => setTools(list))
      .catch((caught: unknown) => {
        setError(caught);
        setTools([]);
      });
  }, []);

  return (
    <>
      <PageHeader
        title="Developer"
        description="The tool schemas the engine validates against, and the HTTP surface they sit behind."
      />

      <ErrorState error={error} />

      <div className="rise">
        <Tabs
          tabs={[
            { id: "tools", label: "Tool catalogue" },
            { id: "endpoints", label: "API reference" },
          ]}
          value={tab}
          onChange={setTab}
        />
      </div>

      {tab === "tools" ? (
        tools === null ? (
          <Card>
            <RowSkeleton rows={3} />
          </Card>
        ) : tools.length === 0 ? (
          <Card>
            <EmptyState
              icon={Icon.tool({ size: 18 })}
              title="No tools registered"
              message="Tools are registered in the backend container at startup. None are currently available."
            />
          </Card>
        ) : (
          <div className="stack">
            {tools.map((tool) => {
              const expanded = open === tool.name;
              return (
                <Card key={tool.name} className="rise">
                  <div className="inline">
                    <span className="metric-icon accent">{Icon.tool({ size: 14 })}</span>
                    <div style={{ minWidth: 0 }}>
                      <div className="strong mono">{tool.name}</div>
                      <div className="muted">{tool.description}</div>
                    </div>
                    <button
                      className="btn ghost sm"
                      style={{ marginLeft: "auto" }}
                      onClick={() => setOpen(expanded ? null : tool.name)}
                      aria-expanded={expanded}
                    >
                      {expanded ? "Hide schema" : "View schema"}
                    </button>
                  </div>

                  {expanded ? (
                    <div style={{ marginTop: 14 }}>
                      <pre>{JSON.stringify(tool.parameters, null, 2)}</pre>
                    </div>
                  ) : null}
                </Card>
              );
            })}
          </div>
        )
      ) : (
        <Card flush className="rise">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 90 }}>Method</th>
                  <th>Path</th>
                  <th>Description</th>
                </tr>
              </thead>
              <tbody>
                {ENDPOINTS.map((endpoint) => (
                  <tr key={`${endpoint.method} ${endpoint.path}`}>
                    <td>
                      <Badge tone={METHOD_TONE[endpoint.method] ?? "neutral"} mono>
                        {endpoint.method}
                      </Badge>
                    </td>
                    <td className="mono">{endpoint.path}</td>
                    <td className="muted">{endpoint.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Card title="Authentication" className="rise">
        <p className="muted" style={{ margin: 0 }}>
          Every <code>/v1</code> route requires an <code>x-api-key</code> header matching one of the configured keys.
          With no keys configured the gateway allows anonymous access, which <code>loadConfig()</code> refuses in
          production. Health and metrics stay unauthenticated so probes and scrapers can reach them.
        </p>
      </Card>
    </>
  );
}
