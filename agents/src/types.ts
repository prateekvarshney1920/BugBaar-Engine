import type { ToolCall, ToolResult } from "@bugbaar/tools";

export type Role = "system" | "user" | "assistant" | "tool";

export interface Message {
  role: Role;
  content: string;
  /** Tool calls requested by the assistant on this turn. */
  toolCalls?: ToolCall[];
  /** Set on `role: "tool"` messages to link a result back to its call. */
  toolCallId?: string;
  createdAt?: string;
}

export interface CompletionRequest {
  messages: Message[];
  tools?: { name: string; description: string; parameters: unknown }[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface CompletionResponse {
  content: string;
  toolCalls?: ToolCall[];
  usage?: { promptTokens: number; completionTokens: number };
  finishReason: "stop" | "tool_calls" | "length";
}

/** One chunk of a streamed completion. */
export interface CompletionChunk {
  /** Text produced since the previous chunk. Empty on a tool-call-only chunk. */
  delta: string;
  /** Present on the final chunk, carrying the assembled response. */
  done?: CompletionResponse;
}

/**
 * Every LLM backend (OpenAI, Ollama, Vercel AI SDK, a local stub) implements
 * this. The runtime never imports a vendor SDK directly.
 *
 * `stream` is optional: a provider that cannot stream simply omits it, and the
 * agent falls back to `complete` and emits the whole message as one token
 * event. Making it optional keeps the contract honest — a provider should not
 * have to fake streaming it does not support.
 */
export interface LlmProvider {
  readonly name: string;
  complete(request: CompletionRequest): Promise<CompletionResponse>;
  stream?(request: CompletionRequest): AsyncIterable<CompletionChunk>;
}

export interface AgentRunStep {
  index: number;
  thought: string;
  toolResults: ToolResult[];
}

export interface AgentRunResult {
  runId: string;
  agentId: string;
  output: string;
  steps: AgentRunStep[];
  messages: Message[];
  stoppedBecause: "completed" | "max_steps" | "aborted";
  durationMs: number;
}
