import { CompletionAssembler, SseDecoder } from "./sse.js";
import type { CompletionChunk, CompletionRequest, CompletionResponse, LlmProvider } from "./types.js";

/**
 * Zero-dependency provider used by tests, examples, and `LLM_PROVIDER=echo`.
 *
 * It never leaves the process, so the whole stack can be exercised end to end
 * without an API key.
 */
export class EchoProvider implements LlmProvider {
  readonly name = "echo";

  constructor(private readonly chunkDelayMs = 0) {}

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    return { content: echoContent(request), finishReason: "stop" };
  }

  /**
   * Emits the reply word by word.
   *
   * Synthetic, but it exercises the real streaming path — the agent loop, the
   * SSE endpoint, and the dashboard — with no API key, which is what makes
   * streaming testable in CI at all.
   */
  async *stream(request: CompletionRequest): AsyncIterable<CompletionChunk> {
    const content = echoContent(request);
    const words = content.split(" ");

    for (const [index, word] of words.entries()) {
      if (request.signal?.aborted) break;
      if (this.chunkDelayMs > 0) await delay(this.chunkDelayMs);
      yield { delta: index === 0 ? word : ` ${word}` };
    }

    yield { delta: "", done: { content, finishReason: "stop" } };
  }
}

function echoContent(request: CompletionRequest): string {
  const lastUser = [...request.messages].reverse().find((m) => m.role === "user");
  return lastUser ? `echo: ${lastUser.content}` : "echo: (no user message)";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface OpenAiProviderOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
}

/**
 * OpenAI-compatible chat completions over plain `fetch`.
 *
 * Talking to the HTTP API directly (instead of pulling in a vendor SDK) keeps
 * the runtime dependency-free and works unchanged against any OpenAI-compatible
 * endpoint — including Ollama's `/v1` shim.
 */
export class OpenAiProvider implements LlmProvider {
  readonly name = "openai";
  readonly #apiKey: string;
  readonly #model: string;
  readonly #baseUrl: string;

  constructor(options: OpenAiProviderOptions) {
    if (!options.apiKey) throw new Error("OpenAiProvider requires an apiKey");
    this.#apiKey = options.apiKey;
    this.#model = options.model ?? "gpt-4o-mini";
    this.#baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
  }

  /** Request body, shared so the streaming and blocking paths cannot diverge. */
  #body(request: CompletionRequest, stream: boolean): string {
    return JSON.stringify({
      model: this.#model,
      temperature: request.temperature ?? 0.2,
      max_tokens: request.maxTokens,
      ...(stream ? { stream: true } : {}),
      messages: request.messages.map((message) => ({
        role: message.role,
        content: message.content,
        ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
      })),
      ...(request.tools?.length
        ? { tools: request.tools.map((tool) => ({ type: "function", function: tool })) }
        : {}),
    });
  }

  #headers(): Record<string, string> {
    return { "content-type": "application/json", authorization: `Bearer ${this.#apiKey}` };
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const response = await fetch(`${this.#baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.#headers(),
      signal: request.signal,
      body: this.#body(request, false),
    });

    if (!response.ok) {
      throw new Error(`OpenAI request failed (${response.status}): ${await response.text()}`);
    }

    const payload = (await response.json()) as OpenAiChatResponse;
    const choice = payload.choices[0];
    if (!choice) throw new Error("OpenAI returned no choices");

    return {
      content: choice.message.content ?? "",
      toolCalls: choice.message.tool_calls?.map((call) => ({
        id: call.id,
        name: call.function.name,
        arguments: safeParseArguments(call.function.arguments),
      })),
      usage: payload.usage && {
        promptTokens: payload.usage.prompt_tokens,
        completionTokens: payload.usage.completion_tokens,
      },
      finishReason:
        choice.finish_reason === "tool_calls" ? "tool_calls" : choice.finish_reason === "length" ? "length" : "stop",
    };
  }

  /**
   * Streams a completion over server-sent events.
   *
   * Decoding is delegated to `SseDecoder` and `CompletionAssembler`, which are
   * pure and unit-tested against fixtures. The failure modes here — a network
   * chunk splitting a line, tool-call arguments arriving a few characters at a
   * time — cannot be reproduced against a live API on demand.
   */
  async *stream(request: CompletionRequest): AsyncIterable<CompletionChunk> {
    const response = await fetch(`${this.#baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.#headers(),
      signal: request.signal,
      body: this.#body(request, true),
    });

    if (!response.ok) {
      throw new Error(`OpenAI stream failed (${response.status}): ${await response.text()}`);
    }
    if (!response.body) throw new Error("OpenAI stream returned no body");

    const reader = response.body.getReader();
    const utf8 = new TextDecoder();
    const decoder = new SseDecoder();
    const assembler = new CompletionAssembler();

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        for (const payload of decoder.push(utf8.decode(value, { stream: true }))) {
          const delta = assembler.accept(payload);
          if (delta) yield { delta };
        }
      }

      for (const payload of decoder.flush()) {
        const delta = assembler.accept(payload);
        if (delta) yield { delta };
      }
    } finally {
      // Releasing the lock lets an aborted run close the socket promptly
      // instead of leaving it pinned until GC.
      reader.releaseLock();
    }

    yield { delta: "", done: assembler.finish() };
  }
}

function safeParseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    // A malformed arguments blob becomes an empty object; the registry's
    // validation then reports the missing fields back to the model.
    return {};
  }
}

interface OpenAiChatResponse {
  choices: {
    finish_reason: string;
    message: {
      content: string | null;
      tool_calls?: { id: string; function: { name: string; arguments: string } }[];
    };
  }[];
  usage?: { prompt_tokens: number; completion_tokens: number };
}
