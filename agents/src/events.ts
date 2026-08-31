import type { ToolCall, ToolResult } from "@bugbaar/tools";
import type { AgentRunResult } from "./types.js";

/**
 * Everything observable about a run, as it happens.
 *
 * The union is closed and discriminated so a consumer — an SSE endpoint, a log
 * shipper, a test — can exhaustively handle it. `run()` and `stream()` share
 * one implementation that emits these; the non-streaming API is just the
 * streaming one drained to completion.
 */
export type AgentEvent =
  | { type: "run-start"; runId: string; agentId: string; input: string }
  /** A step begins: the model is about to be asked. */
  | { type: "step-start"; index: number }
  /** A fragment of assistant text. Providers without token streaming emit one. */
  | { type: "token"; index: number; text: string }
  /** The model's complete message for this step. */
  | { type: "message"; index: number; content: string; toolCalls: ToolCall[] }
  | { type: "tool-start"; index: number; call: ToolCall }
  | { type: "tool-result"; index: number; result: ToolResult }
  | { type: "run-end"; result: AgentRunResult }
  /** The run could not complete. `run()` rethrows; `stream()` yields this last. */
  | { type: "error"; message: string; runId: string };

export type AgentEventType = AgentEvent["type"];

/** Narrows an event by type, for consumers that only care about some of them. */
export function isEvent<T extends AgentEventType>(
  event: AgentEvent,
  type: T,
): event is Extract<AgentEvent, { type: T }> {
  return event.type === type;
}
