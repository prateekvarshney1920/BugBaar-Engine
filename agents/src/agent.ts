import { ToolRegistry, type ToolResult } from "@bugbaar/tools";
import type { AgentEvent } from "./events.js";
import { InMemoryStore, type MemoryStore } from "./memory.js";
import type { AgentRunResult, AgentRunStep, CompletionResponse, LlmProvider, Message } from "./types.js";

export interface AgentOptions {
  id: string;
  /** Human-readable name shown in dashboards and traces. */
  name?: string;
  /** The agent's standing objective, prepended to every run. */
  goal?: string;
  instructions?: string;
  provider: LlmProvider;
  tools?: ToolRegistry;
  memory?: MemoryStore;
  /** Hard cap on reasoning/tool iterations per run. */
  maxSteps?: number;
  temperature?: number;
}

export interface RunOptions {
  sessionId?: string;
  signal?: AbortSignal;
  /** Emitted after each step so callers can follow progress. */
  onStep?: (step: AgentRunStep) => void;
  /**
   * Emitted for every event the run produces, before it is yielded.
   *
   * `run()` drains `stream()`, so an observer registered here sees the same
   * events on both paths. That matters for anything watching the lifecycle —
   * run history, tracing — which would otherwise have to be wired twice and
   * would drift.
   */
  onEvent?: (event: AgentEvent) => void;
}

/**
 * The core agent loop: prompt the model, run any tools it asks for, feed the
 * results back, and repeat until it answers or hits `maxSteps`.
 *
 * The loop is written once, as an async generator that yields `AgentEvent`s
 * and returns the final result. `stream()` exposes it directly; `run()` drains
 * it. Two public shapes, one implementation — a separate non-streaming path
 * would inevitably drift from the streaming one.
 */
export class Agent {
  readonly id: string;
  readonly name: string;
  readonly #goal?: string;
  readonly #instructions?: string;
  readonly #provider: LlmProvider;
  readonly #tools: ToolRegistry;
  readonly #memory: MemoryStore;
  readonly #maxSteps: number;
  readonly #temperature: number;

  constructor(options: AgentOptions) {
    this.id = options.id;
    this.name = options.name ?? options.id;
    this.#goal = options.goal;
    this.#instructions = options.instructions;
    this.#provider = options.provider;
    this.#tools = options.tools ?? new ToolRegistry();
    this.#memory = options.memory ?? new InMemoryStore();
    this.#maxSteps = options.maxSteps ?? 8;
    this.#temperature = options.temperature ?? 0.2;
  }

  get tools(): ToolRegistry {
    return this.#tools;
  }

  get memory(): MemoryStore {
    return this.#memory;
  }

  /** True when the configured provider can emit tokens as they are produced. */
  get streaming(): boolean {
    return typeof this.#provider.stream === "function";
  }

  /**
   * Runs to completion, discarding intermediate events.
   *
   * `onStep` still fires — the generator emits it — so existing callers are
   * unaffected by the loop having become streaming underneath them.
   */
  async run(input: string, options: RunOptions = {}): Promise<AgentRunResult> {
    const iterator = this.stream(input, options);

    for (;;) {
      const next = await iterator.next();
      if (next.done) return next.value;
    }
  }

  /**
   * Runs the agent, yielding events as they happen.
   *
   * The generator's return value is the completed run, so a caller can both
   * follow progress and collect the result from one call.
   */
  async *stream(input: string, options: RunOptions = {}): AsyncGenerator<AgentEvent, AgentRunResult> {
    const startedAt = performance.now();
    const runId = crypto.randomUUID();
    const sessionId = options.sessionId ?? this.id;

    const emit = (event: AgentEvent): AgentEvent => {
      options.onEvent?.(event);
      return event;
    };

    yield emit({ type: "run-start", runId, agentId: this.id, input });

    const history = await this.#memory.history(sessionId);
    const messages: Message[] = [...this.#systemMessages(), ...history, { role: "user", content: input }];

    const steps: AgentRunStep[] = [];
    let output = "";
    let stoppedBecause: AgentRunResult["stoppedBecause"] = "max_steps";

    for (let index = 0; index < this.#maxSteps; index += 1) {
      if (options.signal?.aborted) {
        stoppedBecause = "aborted";
        break;
      }

      yield emit({ type: "step-start", index });

      const request = {
        messages,
        tools: this.#tools.list().length > 0 ? this.#tools.describe() : undefined,
        temperature: this.#temperature,
        signal: options.signal,
      };

      let completion: CompletionResponse;

      if (this.#provider.stream) {
        let assembled: CompletionResponse | undefined;

        for await (const chunk of this.#provider.stream(request)) {
          if (chunk.delta) yield emit({ type: "token", index, text: chunk.delta });
          if (chunk.done) assembled = chunk.done;
        }

        if (!assembled) throw new Error(`Provider "${this.#provider.name}" streamed no final response`);
        completion = assembled;
      } else {
        completion = await this.#provider.complete(request);
        // Keep the event shape identical for non-streaming providers, so a
        // consumer never needs to know which kind it is talking to.
        if (completion.content) yield emit({ type: "token", index, text: completion.content });
      }

      const toolCalls = completion.toolCalls ?? [];
      yield emit({ type: "message", index, content: completion.content, toolCalls });

      messages.push({
        role: "assistant",
        content: completion.content,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      });

      if (toolCalls.length === 0) {
        output = completion.content;
        stoppedBecause = "completed";
        break;
      }

      for (const call of toolCalls) yield emit({ type: "tool-start", index, call });

      // Tool calls in a single turn are independent by contract, so run them
      // concurrently and preserve the model's ordering in the transcript.
      const toolResults: ToolResult[] = await Promise.all(
        toolCalls.map((call) => this.#tools.execute(call, { agentId: this.id, runId, signal: options.signal })),
      );

      for (const result of toolResults) {
        yield emit({ type: "tool-result", index, result });
        messages.push({
          role: "tool",
          toolCallId: result.callId,
          content: result.ok ? JSON.stringify(result.output) : `Error: ${result.error}`,
        });
      }

      const step: AgentRunStep = { index, thought: completion.content, toolResults };
      steps.push(step);
      options.onStep?.(step);
    }

    await this.#memory.append(sessionId, [
      { role: "user", content: input },
      { role: "assistant", content: output },
    ]);

    const result: AgentRunResult = {
      runId,
      agentId: this.id,
      output,
      steps,
      messages,
      stoppedBecause,
      durationMs: Math.round(performance.now() - startedAt),
    };

    yield emit({ type: "run-end", result });
    return result;
  }

  #systemMessages(): Message[] {
    const parts = [this.#instructions, this.#goal && `Your goal: ${this.#goal}`].filter(Boolean);
    return parts.length > 0 ? [{ role: "system", content: parts.join("\n\n") }] : [];
  }
}
