import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { calculatorTool, ToolRegistry } from "@bugbaar/tools";
import { Agent } from "./agent.ts";
import type { AgentEvent } from "./events.ts";
import { EchoProvider } from "./providers.ts";
import { CompletionAssembler, SseDecoder } from "./sse.ts";
import type { CompletionChunk, CompletionResponse, LlmProvider } from "./types.ts";

/** Replays a fixed script, with no streaming support at all. */
class BlockingProvider implements LlmProvider {
  readonly name = "blocking";
  #index = 0;

  constructor(private readonly script: CompletionResponse[]) {}

  async complete(): Promise<CompletionResponse> {
    const response = this.script[this.#index++];
    if (!response) throw new Error("BlockingProvider ran out of responses");
    return response;
  }
}

/** Replays a script, emitting each response one character at a time. */
class ChunkedProvider implements LlmProvider {
  readonly name = "chunked";
  #index = 0;

  constructor(private readonly script: CompletionResponse[]) {}

  async complete(): Promise<CompletionResponse> {
    const response = this.script[this.#index];
    if (!response) throw new Error("ChunkedProvider ran out of responses");
    return response;
  }

  async *stream(): AsyncIterable<CompletionChunk> {
    const response = this.script[this.#index++];
    if (!response) throw new Error("ChunkedProvider ran out of responses");

    for (const character of response.content) yield { delta: character };
    yield { delta: "", done: response };
  }
}

async function collect(agent: Agent, input: string): Promise<{ events: AgentEvent[]; result: unknown }> {
  const events: AgentEvent[] = [];
  const iterator = agent.stream(input);

  for (;;) {
    const next = await iterator.next();
    if (next.done) return { events, result: next.value };
    events.push(next.value);
  }
}

describe("Agent.stream", () => {
  test("emits a run-start, tokens, a message, and a run-end", async () => {
    const agent = new Agent({ id: "s1", provider: new EchoProvider() });
    const { events } = await collect(agent, "hello world");

    const types = events.map((event) => event.type);
    assert.equal(types[0], "run-start");
    assert.equal(types.at(-1), "run-end");
    assert.ok(types.includes("token"), "a streaming provider must produce token events");
    assert.ok(types.includes("message"));
  });

  test("tokens concatenate to exactly the final output", async () => {
    const agent = new Agent({ id: "s2", provider: new EchoProvider() });
    const { events } = await collect(agent, "the quick brown fox");

    const streamed = events
      .filter((event) => event.type === "token")
      .map((event) => event.text)
      .join("");
    const message = events.find((event) => event.type === "message");

    assert.equal(streamed, "echo: the quick brown fox");
    assert.equal(streamed, message?.content);
  });

  test("run() returns the same result the stream ends with", async () => {
    const agent = new Agent({ id: "s3", provider: new EchoProvider() });

    const streamed = await collect(agent, "same either way");
    const runResult = await new Agent({ id: "s3", provider: new EchoProvider() }).run("same either way");

    const endEvent = streamed.events.find((event) => event.type === "run-end");
    assert.equal(endEvent?.result.output, runResult.output);
    assert.equal(endEvent?.result.stoppedBecause, runResult.stoppedBecause);
  });

  /*
   * A provider without `stream` must still produce token events, or every
   * consumer would need two rendering paths. The agent emits the whole message
   * as a single token instead.
   */
  test("a non-streaming provider still yields one token event", async () => {
    const agent = new Agent({
      id: "s4",
      provider: new BlockingProvider([{ content: "all at once", finishReason: "stop" }]),
    });

    const { events } = await collect(agent, "go");
    const tokens = events.filter((event) => event.type === "token");

    assert.equal(agent.streaming, false);
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0]?.text, "all at once");
  });

  test("tool calls surface as ordered tool-start and tool-result events", async () => {
    const agent = new Agent({
      id: "s5",
      tools: new ToolRegistry([calculatorTool]),
      provider: new ChunkedProvider([
        {
          content: "Let me multiply.",
          toolCalls: [{ id: "c1", name: "calculator", arguments: { a: 6, b: 7, operation: "multiply" } }],
          finishReason: "tool_calls",
        },
        { content: "It is 42.", finishReason: "stop" },
      ]),
    });

    const { events } = await collect(agent, "6 times 7?");
    const types = events.map((event) => event.type);

    assert.ok(types.indexOf("tool-start") < types.indexOf("tool-result"), "a call must precede its result");

    const result = events.find((event) => event.type === "tool-result");
    assert.equal(result?.result.ok, true);
    assert.equal(result?.result.output, 42);
  });

  test("a failing tool is reported as an event, not thrown", async () => {
    const agent = new Agent({
      id: "s6",
      tools: new ToolRegistry([calculatorTool]),
      provider: new ChunkedProvider([
        {
          content: "Dividing.",
          toolCalls: [{ id: "c1", name: "calculator", arguments: { a: 1, b: 0, operation: "divide" } }],
          finishReason: "tool_calls",
        },
        { content: "That failed.", finishReason: "stop" },
      ]),
    });

    const { events } = await collect(agent, "1 / 0");
    const result = events.find((event) => event.type === "tool-result");

    assert.equal(result?.result.ok, false);
    assert.match(result?.result.error ?? "", /Division by zero/);
  });

  test("an aborted run ends without calling the provider", async () => {
    const agent = new Agent({ id: "s7", provider: new EchoProvider() });
    const events: AgentEvent[] = [];

    const iterator = agent.stream("never runs", { signal: AbortSignal.abort() });
    for (;;) {
      const next = await iterator.next();
      if (next.done) {
        assert.equal(next.value.stoppedBecause, "aborted");
        break;
      }
      events.push(next.value);
    }

    assert.equal(
      events.some((event) => event.type === "token"),
      false,
    );
  });
});

describe("SseDecoder", () => {
  test("extracts data payloads from complete events", () => {
    const decoder = new SseDecoder();
    assert.deepEqual(decoder.push('data: {"a":1}\n\ndata: {"b":2}\n\n'), ['{"a":1}', '{"b":2}']);
  });

  /*
   * The case that makes a stateful decoder necessary: a network chunk can end
   * anywhere, including halfway through a JSON payload. A stateless split
   * would emit a truncated frame and lose the rest.
   */
  test("reassembles a payload split across chunks", () => {
    const decoder = new SseDecoder();

    assert.deepEqual(decoder.push('data: {"hel'), []);
    assert.deepEqual(decoder.push('lo":"world"}\n\n'), ['{"hello":"world"}']);
  });

  test("holds back an event with no terminating blank line", () => {
    const decoder = new SseDecoder();

    assert.deepEqual(decoder.push('data: {"partial":true}\n'), []);
    assert.deepEqual(decoder.flush(), ['{"partial":true}']);
  });

  test("ignores comments, blank data, and non-data lines", () => {
    const decoder = new SseDecoder();
    const payloads = decoder.push(': keep-alive\n\nevent: ping\n\ndata:\n\ndata: {"real":1}\n\n');

    assert.deepEqual(payloads, ['{"real":1}']);
  });

  test("flush on an empty buffer yields nothing", () => {
    assert.deepEqual(new SseDecoder().flush(), []);
  });
});

describe("CompletionAssembler", () => {
  const frame = (delta: unknown, finish: string | null = null): string =>
    JSON.stringify({ choices: [{ delta, finish_reason: finish }] });

  test("concatenates content deltas", () => {
    const assembler = new CompletionAssembler();

    assert.equal(assembler.accept(frame({ content: "Hel" })), "Hel");
    assert.equal(assembler.accept(frame({ content: "lo" })), "lo");

    assert.equal(assembler.finish().content, "Hello");
  });

  /*
   * Tool-call arguments arrive as JSON fragments across many frames, keyed by
   * index. Parsing any single fragment fails; they must be concatenated first.
   */
  test("reassembles tool-call arguments from fragments", () => {
    const assembler = new CompletionAssembler();

    assembler.accept(frame({ tool_calls: [{ index: 0, id: "call_1", function: { name: "calculator" } }] }));
    assembler.accept(frame({ tool_calls: [{ index: 0, function: { arguments: '{"a":6,' } }] }));
    assembler.accept(frame({ tool_calls: [{ index: 0, function: { arguments: '"b":7,' } }] }));
    assembler.accept(frame({ tool_calls: [{ index: 0, function: { arguments: '"operation":"multiply"}' } }] }));

    const response = assembler.finish();

    assert.equal(response.finishReason, "tool_calls");
    assert.equal(response.toolCalls?.length, 1);
    assert.equal(response.toolCalls?.[0]?.name, "calculator");
    assert.deepEqual(response.toolCalls?.[0]?.arguments, { a: 6, b: 7, operation: "multiply" });
  });

  test("keeps parallel tool calls separate and in index order", () => {
    const assembler = new CompletionAssembler();

    assembler.accept(frame({ tool_calls: [{ index: 1, id: "b", function: { name: "second", arguments: "{}" } }] }));
    assembler.accept(frame({ tool_calls: [{ index: 0, id: "a", function: { name: "first", arguments: "{}" } }] }));

    const names = assembler.finish().toolCalls?.map((call) => call.name);
    assert.deepEqual(names, ["first", "second"]);
  });

  test("truncated arguments degrade to an empty object rather than throwing", () => {
    const assembler = new CompletionAssembler();
    assembler.accept(frame({ tool_calls: [{ index: 0, id: "x", function: { name: "t", arguments: '{"a":' } }] }));

    // The tool registry then reports the missing fields back to the model,
    // which can correct itself — better than failing the whole run here.
    assert.deepEqual(assembler.finish().toolCalls?.[0]?.arguments, {});
  });

  test("a malformed frame is skipped without aborting the run", () => {
    const assembler = new CompletionAssembler();

    assembler.accept(frame({ content: "good" }));
    assert.equal(assembler.accept("{not json"), "");
    assembler.accept(frame({ content: " again" }));

    assert.equal(assembler.finish().content, "good again");
  });

  test("[DONE] is ignored", () => {
    const assembler = new CompletionAssembler();
    assembler.accept(frame({ content: "text" }));

    assert.equal(assembler.accept("[DONE]"), "");
    assert.equal(assembler.finish().content, "text");
  });

  test("carries through a length finish reason", () => {
    const assembler = new CompletionAssembler();
    assembler.accept(frame({ content: "cut off" }, "length"));

    assert.equal(assembler.finish().finishReason, "length");
  });
});
