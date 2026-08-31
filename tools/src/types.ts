/**
 * A minimal, provider-agnostic description of a callable tool.
 *
 * The shape intentionally mirrors the OpenAI / Anthropic function-calling
 * contract so a `ToolDefinition` can be serialised straight into a request
 * without an adapter layer.
 */
export interface JsonSchema {
  type: "object";
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface JsonSchemaProperty {
  type: "string" | "number" | "integer" | "boolean" | "array" | "object";
  description?: string;
  enum?: readonly string[];
  items?: JsonSchemaProperty;
  default?: unknown;
}

export interface ToolContext {
  /** Identifier of the agent invoking the tool. */
  agentId: string;
  /** Correlation id shared by every step of a single run. */
  runId: string;
  /** Aborts long-running tool work when the agent run is cancelled. */
  signal?: AbortSignal;
}

export interface Tool<TInput = Record<string, unknown>, TOutput = unknown> {
  name: string;
  description: string;
  parameters: JsonSchema;
  execute(input: TInput, context: ToolContext): Promise<TOutput>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  callId: string;
  name: string;
  ok: boolean;
  output: unknown;
  error?: string;
  durationMs: number;
}
