/** Wire types shared by the backend and any client SDK. */

export interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
  requestId: string;
}

export interface HealthResponse {
  status: "ok" | "degraded";
  uptimeSeconds: number;
  version: string;
  dependencies: Record<string, "up" | "down" | "not_configured">;
}

export interface CreateAgentRequest {
  id: string;
  name?: string;
  goal?: string;
  instructions?: string;
  tools?: string[];
  maxSteps?: number;
}

export interface AgentSummary {
  id: string;
  name: string;
  goal?: string;
  tools: string[];
  createdAt: string;
}

export interface RunAgentRequest {
  input: string;
  sessionId?: string;
}

export interface RunAgentResponse {
  runId: string;
  agentId: string;
  output: string;
  stoppedBecause: string;
  steps: { index: number; thought: string; tools: { name: string; ok: boolean; durationMs: number }[] }[];
  durationMs: number;
}

export interface IngestRequest {
  documents: { id: string; text: string; metadata?: Record<string, unknown> }[];
}

export interface IngestResponse {
  documents: number;
  chunks: number;
}

export interface SearchRequest {
  query: string;
  topK?: number;
  filter?: Record<string, unknown>;
}

export interface SearchResponse {
  query: string;
  hits: { documentId: string; chunkId: string; text: string; score: number }[];
}

export interface RunWorkflowRequest {
  input?: Record<string, unknown>;
}

export interface WorkflowSummary {
  name: string;
  description?: string;
  steps: { name: string; description?: string }[];
}
