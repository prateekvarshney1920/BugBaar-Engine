import type {
  AgentSummary,
  CreateAgentRequest,
  HealthResponse,
  IngestResponse,
  RunAgentResponse,
  SearchResponse,
  WorkflowSummary,
} from "@bugbaar/api";

/** Mirrors the engine's error envelope so the UI can show its message and code. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const API_KEY_STORAGE = "bugbaar.apiKey";

export function getApiKey(): string {
  try {
    return localStorage.getItem(API_KEY_STORAGE) ?? "";
  } catch {
    // Private-browsing modes can throw on access; an empty key is the safe default.
    return "";
  }
}

export function setApiKey(key: string): void {
  try {
    if (key) localStorage.setItem(API_KEY_STORAGE, key);
    else localStorage.removeItem(API_KEY_STORAGE);
  } catch {
    // Storage is a convenience here — the in-memory key still works this session.
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-api-key": getApiKey(),
      ...init.headers,
    },
  });

  if (response.status === 204) return undefined as T;

  const requestId = response.headers.get("x-request-id") ?? undefined;
  const text = await response.text();
  const payload: unknown = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const envelope = payload as { error?: { code?: string; message?: string } } | null;
    throw new ApiError(
      response.status,
      envelope?.error?.code ?? "unknown",
      envelope?.error?.message ?? `Request failed with status ${response.status}`,
      requestId,
    );
  }

  return payload as T;
}

const post = <T>(path: string, body: unknown): Promise<T> =>
  request<T>(path, { method: "POST", body: JSON.stringify(body) });

export const api = {
  health: () => request<HealthResponse>("/health"),

  listAgents: () => request<{ agents: AgentSummary[] }>("/v1/agents"),
  createAgent: (body: CreateAgentRequest) => post<AgentSummary>("/v1/agents", body),
  deleteAgent: (id: string) => request<void>(`/v1/agents/${encodeURIComponent(id)}`, { method: "DELETE" }),
  runAgent: (id: string, input: string, sessionId?: string) =>
    post<RunAgentResponse>(`/v1/agents/${encodeURIComponent(id)}/run`, {
      input,
      ...(sessionId ? { sessionId } : {}),
    }),

  listTools: () => request<{ tools: { name: string; description: string; parameters: unknown }[] }>("/v1/tools"),

  ingest: (documents: { id: string; text: string }[]) =>
    post<IngestResponse>("/v1/knowledge/documents", { documents }),
  search: (query: string, topK: number) => post<SearchResponse>("/v1/knowledge/search", { query, topK }),
  knowledgeStats: () => request<{ chunks: number }>("/v1/knowledge/stats"),
  deleteDocument: (id: string) =>
    request<void>(`/v1/knowledge/documents/${encodeURIComponent(id)}`, { method: "DELETE" }),

  listWorkflows: () => request<{ workflows: WorkflowSummary[] }>("/v1/workflows"),

  /**
   * A failed workflow is a 422 carrying a full WorkflowRun, not an error
   * envelope — the run record *is* the answer. Only genuine transport and
   * auth failures should surface as an ApiError here.
   */
  runWorkflow: async (name: string, input: Record<string, unknown>): Promise<WorkflowRun> => {
    const response = await fetch(`/v1/workflows/${encodeURIComponent(name)}/run`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": getApiKey() },
      body: JSON.stringify({ input }),
    });

    const payload: unknown = await response.json();

    if (response.ok || response.status === 422) return payload as WorkflowRun;

    const envelope = payload as { error?: { code?: string; message?: string } } | null;
    throw new ApiError(
      response.status,
      envelope?.error?.code ?? "unknown",
      envelope?.error?.message ?? `Request failed with status ${response.status}`,
      response.headers.get("x-request-id") ?? undefined,
    );
  },
  workflowRuns: () => request<{ runs: WorkflowRun[] }>("/v1/workflows/runs"),
};

/** Mirrors the engine's AgentEvent union. */
export type AgentEvent =
  | { type: "run-start"; runId: string; agentId: string; input: string }
  | { type: "step-start"; index: number }
  | { type: "token"; index: number; text: string }
  | { type: "message"; index: number; content: string; toolCalls: { id: string; name: string }[] }
  | { type: "tool-start"; index: number; call: { id: string; name: string } }
  | {
      type: "tool-result";
      index: number;
      result: { callId: string; name: string; ok: boolean; error?: string; durationMs: number };
    }
  | { type: "run-end"; result: RunAgentResponse }
  | { type: "error"; message: string; runId: string };

/**
 * Streams an agent run, yielding events as the server emits them.
 *
 * EventSource is not used because it cannot issue a POST or set headers, and
 * the run needs both a body and an API key. Reading the fetch body directly
 * costs a small SSE parser and gives full control over cancellation.
 */
export async function* streamAgentRun(
  agentId: string,
  input: string,
  options: { sessionId?: string; signal?: AbortSignal } = {},
): AsyncGenerator<AgentEvent> {
  const response = await fetch(`/v1/agents/${encodeURIComponent(agentId)}/run/stream`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": getApiKey() },
    body: JSON.stringify({ input, ...(options.sessionId ? { sessionId: options.sessionId } : {}) }),
    signal: options.signal,
  });

  if (!response.ok) {
    // A failure before the stream opens still arrives as a normal JSON error.
    const payload: unknown = await response.json().catch(() => null);
    const envelope = payload as { error?: { code?: string; message?: string } } | null;
    throw new ApiError(
      response.status,
      envelope?.error?.code ?? "unknown",
      envelope?.error?.message ?? `Stream failed with status ${response.status}`,
      response.headers.get("x-request-id") ?? undefined,
    );
  }
  if (!response.body) throw new Error("The stream returned no body");

  const reader = response.body.getReader();
  const utf8 = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += utf8.decode(value, { stream: true });

      // Events are separated by a blank line; a partial trailing event stays
      // buffered until the rest of it arrives.
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() ?? "";

      for (const block of blocks) {
        const data = /^data: (.+)$/m.exec(block)?.[1];
        if (data) yield JSON.parse(data) as AgentEvent;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Local mirror of the engine's WorkflowRun record. */
export interface WorkflowRun {
  runId: string;
  workflow: string;
  status: "succeeded" | "failed" | "aborted";
  steps: {
    name: string;
    status: string;
    attempts: number;
    output?: unknown;
    error?: string;
    durationMs: number;
  }[];
  results: Record<string, unknown>;
  error?: string;
  startedAt: string;
  durationMs: number;
}
