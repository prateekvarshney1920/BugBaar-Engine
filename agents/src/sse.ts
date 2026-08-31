import type { ToolCall } from "@bugbaar/tools";
import type { CompletionResponse } from "./types.js";

/**
 * Parsing for OpenAI-compatible streaming responses.
 *
 * Kept as pure functions over strings rather than buried in the provider so
 * the tricky parts — chunk boundaries that split a line, tool-call arguments
 * arriving a few characters at a time — can be tested against fixtures without
 * a network call or an API key.
 */

export interface StreamDelta {
  content?: string;
  tool_calls?: {
    index: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }[];
}

interface StreamPayload {
  choices?: { delta?: StreamDelta; finish_reason?: string | null }[];
}

/**
 * Splits a byte stream into `data:` payloads.
 *
 * Server-sent events are delimited by blank lines, and a network chunk can end
 * anywhere — including mid-line. The leftover is carried into the next call,
 * which is the whole reason this is stateful.
 */
export class SseDecoder {
  #buffer = "";

  /** Returns the complete `data:` payloads contained in this chunk. */
  push(chunk: string): string[] {
    this.#buffer += chunk;
    const payloads: string[] = [];

    // Events are separated by a blank line; anything after the last one is an
    // incomplete event and stays buffered.
    const parts = this.#buffer.split("\n\n");
    this.#buffer = parts.pop() ?? "";

    for (const part of parts) {
      for (const line of part.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;

        const payload = trimmed.slice(5).trim();
        if (payload) payloads.push(payload);
      }
    }

    return payloads;
  }

  /** Any trailing event left when the stream ends without a final blank line. */
  flush(): string[] {
    if (!this.#buffer.trim()) return [];
    const remaining = this.push("\n\n");
    this.#buffer = "";
    return remaining;
  }
}

/**
 * Reassembles a completion from streamed deltas.
 *
 * Tool calls are the awkward part: the model sends a name once and then its
 * JSON arguments in fragments across many chunks, keyed by index. They have to
 * be concatenated before the JSON is parseable at all.
 */
export class CompletionAssembler {
  #content = "";
  #finishReason: CompletionResponse["finishReason"] = "stop";
  readonly #toolCalls = new Map<number, { id: string; name: string; arguments: string }>();

  /** Applies one payload; returns the text delta it contained, if any. */
  accept(payload: string): string {
    if (payload === "[DONE]") return "";

    let parsed: StreamPayload;
    try {
      parsed = JSON.parse(payload) as StreamPayload;
    } catch {
      // A malformed frame should not abort a run that is otherwise fine.
      return "";
    }

    const choice = parsed.choices?.[0];
    if (!choice) return "";

    if (choice.finish_reason === "tool_calls") this.#finishReason = "tool_calls";
    else if (choice.finish_reason === "length") this.#finishReason = "length";

    for (const call of choice.delta?.tool_calls ?? []) {
      const existing = this.#toolCalls.get(call.index) ?? { id: "", name: "", arguments: "" };
      this.#toolCalls.set(call.index, {
        id: call.id ?? existing.id,
        name: call.function?.name ?? existing.name,
        arguments: existing.arguments + (call.function?.arguments ?? ""),
      });
    }

    const delta = choice.delta?.content ?? "";
    this.#content += delta;
    return delta;
  }

  finish(): CompletionResponse {
    const toolCalls: ToolCall[] = [...this.#toolCalls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, call]) => ({
        id: call.id || `call_${index}`,
        name: call.name,
        arguments: parseArguments(call.arguments),
      }));

    return {
      content: this.#content,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      // A stream carrying tool calls does not always set finish_reason before
      // the connection closes, so infer it from what actually arrived.
      finishReason: toolCalls.length > 0 ? "tool_calls" : this.#finishReason,
    };
  }
}

function parseArguments(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    // Truncated arguments become an empty object; the registry's validation
    // then reports the missing fields back to the model.
    return {};
  }
}
