import assert from "node:assert/strict";
import { test } from "node:test";
import { calculatorTool, ToolRegistry } from "@bugbaar/tools";
import { Agent } from "./agent.ts";
import { InMemoryStore } from "./memory.ts";
import { EchoProvider } from "./providers.ts";
import type { CompletionRequest, CompletionResponse, LlmProvider } from "./types.ts";

/** Replays a fixed sequence of completions so the loop is deterministic. */
class ScriptedProvider implements LlmProvider {
  readonly name = "scripted";
  readonly requests: CompletionRequest[] = [];
  #index = 0;

  constructor(private readonly script: CompletionResponse[]) {}

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    this.requests.push(request);
    const response = this.script[this.#index++];
    if (!response) throw new Error("ScriptedProvider ran out of responses");
    return response;
  }
}

test("returns the model's answer when no tools are called", async () => {
  const agent = new Agent({ id: "a1", provider: new EchoProvider() });
  const result = await agent.run("hello");

  assert.equal(result.output, "echo: hello");
  assert.equal(result.stoppedBecause, "completed");
  assert.equal(result.steps.length, 0);
});

test("runs a tool call and feeds the result back to the model", async () => {
  const provider = new ScriptedProvider([
    {
      content: "I need to multiply.",
      toolCalls: [{ id: "call-1", name: "calculator", arguments: { a: 6, b: 7, operation: "multiply" } }],
      finishReason: "tool_calls",
    },
    { content: "The answer is 42.", finishReason: "stop" },
  ]);

  const agent = new Agent({ id: "a2", provider, tools: new ToolRegistry([calculatorTool]) });
  const result = await agent.run("what is 6 times 7?");

  assert.equal(result.output, "The answer is 42.");
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0]?.toolResults[0]?.output, 42);

  const toolMessage = result.messages.find((message) => message.role === "tool");
  assert.equal(toolMessage?.content, "42");
});

test("stops at maxSteps when the model never finishes", async () => {
  const looping: CompletionResponse = {
    content: "again",
    toolCalls: [{ id: "c", name: "calculator", arguments: { a: 1, b: 1, operation: "add" } }],
    finishReason: "tool_calls",
  };
  const provider = new ScriptedProvider(Array.from({ length: 5 }, () => looping));

  const agent = new Agent({ id: "a3", provider, tools: new ToolRegistry([calculatorTool]), maxSteps: 3 });
  const result = await agent.run("loop");

  assert.equal(result.stoppedBecause, "max_steps");
  assert.equal(result.steps.length, 3);
});

test("memory carries context into the next run", async () => {
  const memory = new InMemoryStore();
  const agent = new Agent({ id: "a4", provider: new EchoProvider(), memory });

  await agent.run("first");
  await agent.run("second");

  const history = await memory.history("a4");
  assert.equal(history.length, 4);
  assert.equal(history[0]?.content, "first");
});

test("an aborted signal stops the run before calling the provider", async () => {
  const provider = new ScriptedProvider([{ content: "unused", finishReason: "stop" }]);
  const agent = new Agent({ id: "a5", provider });

  const result = await agent.run("hi", { signal: AbortSignal.abort() });

  assert.equal(result.stoppedBecause, "aborted");
  assert.equal(provider.requests.length, 0);
});
