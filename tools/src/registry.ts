import type { Tool, ToolCall, ToolContext, ToolResult } from "./types.js";
import { ToolValidationError, validateInput } from "./validate.js";

/**
 * Holds the tools an agent is allowed to call and executes them safely:
 * arguments are validated, failures are captured rather than thrown, and every
 * call is timed so the trace layer has something to record.
 */
export class ToolRegistry {
  readonly #tools = new Map<string, Tool>();

  constructor(tools: Tool[] = []) {
    for (const tool of tools) this.register(tool);
  }

  register(tool: Tool): this {
    if (this.#tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered`);
    }
    this.#tools.set(tool.name, tool);
    return this;
  }

  get(name: string): Tool | undefined {
    return this.#tools.get(name);
  }

  has(name: string): boolean {
    return this.#tools.has(name);
  }

  list(): Tool[] {
    return [...this.#tools.values()];
  }

  /** Tool definitions in the shape LLM providers expect. */
  describe(): { name: string; description: string; parameters: unknown }[] {
    return this.list().map(({ name, description, parameters }) => ({ name, description, parameters }));
  }

  async execute(call: ToolCall, context: ToolContext): Promise<ToolResult> {
    const startedAt = performance.now();
    const fail = (error: string): ToolResult => ({
      callId: call.id,
      name: call.name,
      ok: false,
      output: null,
      error,
      durationMs: Math.round(performance.now() - startedAt),
    });

    const tool = this.#tools.get(call.name);
    if (!tool) {
      return fail(
        `Unknown tool "${call.name}". Available: ${
          this.list()
            .map((t) => t.name)
            .join(", ") || "none"
        }`,
      );
    }

    try {
      const input = validateInput(tool.parameters, call.arguments);
      const output = await tool.execute(input, context);
      return {
        callId: call.id,
        name: call.name,
        ok: true,
        output,
        durationMs: Math.round(performance.now() - startedAt),
      };
    } catch (error) {
      if (error instanceof ToolValidationError) return fail(error.message);
      return fail(error instanceof Error ? error.message : String(error));
    }
  }
}
