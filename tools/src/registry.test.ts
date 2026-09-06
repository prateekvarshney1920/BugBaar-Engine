import assert from "node:assert/strict";
import { test } from "node:test";
import { calculatorTool, createHttpTool } from "./builtin.ts";
import { ToolRegistry } from "./registry.ts";
import { validateInput, ToolValidationError } from "./validate.ts";

const context = { agentId: "test-agent", runId: "test-run" };

test("executes a registered tool", async () => {
  const registry = new ToolRegistry([calculatorTool]);
  const result = await registry.execute(
    { id: "1", name: "calculator", arguments: { a: 6, b: 7, operation: "multiply" } },
    context,
  );

  assert.equal(result.ok, true);
  assert.equal(result.output, 42);
});

test("reports unknown tools instead of throwing", async () => {
  const registry = new ToolRegistry([calculatorTool]);
  const result = await registry.execute({ id: "1", name: "nope", arguments: {} }, context);

  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /Unknown tool/);
});

test("captures tool errors as failed results", async () => {
  const registry = new ToolRegistry([calculatorTool]);
  const result = await registry.execute(
    { id: "1", name: "calculator", arguments: { a: 1, b: 0, operation: "divide" } },
    context,
  );

  assert.equal(result.ok, false);
  assert.equal(result.error, "Division by zero");
});

test("rejects duplicate registration", () => {
  const registry = new ToolRegistry([calculatorTool]);
  assert.throws(() => registry.register(calculatorTool), /already registered/);
});

test("validation reports every missing field at once", () => {
  try {
    validateInput(calculatorTool.parameters, { a: 1 });
    assert.fail("expected validation to throw");
  } catch (error) {
    assert.ok(error instanceof ToolValidationError);
    assert.equal(error.issues.length, 2);
  }
});

test("validation rejects values outside an enum", () => {
  assert.throws(
    () => validateInput(calculatorTool.parameters, { a: 1, b: 2, operation: "modulo" }),
    /expected one of/,
  );
});

/*
 * The http tool's allowlist is only worth anything if it survives a redirect.
 *
 * The stub below deliberately imitates the platform's own redirect behaviour:
 * unless the caller asks for `redirect: "manual"`, it follows the chain itself,
 * exactly as real `fetch` would, and records every URL it touches. That is what
 * makes these regression tests rather than shape assertions — against the old
 * implementation the recording shows the request actually reaching the blocked
 * address, which is the SSRF.
 */

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

interface StubHop {
  status: number;
  location?: string;
}

/** Replaces `fetch` with a scripted redirect chain, recording each request. */
function stubFetch(hops: StubHop[]): { requested: string[]; restore: () => void } {
  const requested: string[] = [];
  const realFetch = globalThis.fetch;
  let index = 0;

  const respond = (url: string): Response => {
    requested.push(url);
    const hop = hops[Math.min(index++, hops.length - 1)]!;
    return new Response("body", {
      status: hop.status,
      headers: hop.location ? { location: hop.location } : {},
    });
  };

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    let url = input instanceof Request ? input.url : String(input);
    let response = respond(url);

    if (init?.redirect !== "manual") {
      // The dangerous default: the caller gets no say in where this ends up.
      for (let i = 0; i < 10 && REDIRECT_STATUS.has(response.status); i += 1) {
        const location = response.headers.get("location");
        if (!location) break;
        url = new URL(location, url).toString();
        response = respond(url);
      }
    }

    return response;
  };

  return { requested, restore: () => (globalThis.fetch = realFetch) };
}

const httpTool = createHttpTool({ allowedHosts: ["allowed.example", "second.example"] });

test("a redirect to a host outside the allowlist is rejected", async () => {
  const stub = stubFetch([{ status: 302, location: "http://169.254.169.254/latest/meta-data/" }, { status: 200 }]);

  try {
    await assert.rejects(
      httpTool.execute({ url: "https://allowed.example/start" }, context),
      /Host "169.254.169.254" is not on the allowlist/,
    );

    // The whole point: the blocked address is never contacted at all.
    assert.deepEqual(stub.requested, ["https://allowed.example/start"]);
  } finally {
    stub.restore();
  }
});

test("a redirect between allowed hosts is followed", async () => {
  const stub = stubFetch([{ status: 302, location: "https://second.example/next" }, { status: 200 }]);

  try {
    const result = await httpTool.execute({ url: "https://allowed.example/start" }, context);

    assert.deepEqual(stub.requested, ["https://allowed.example/start", "https://second.example/next"]);
    assert.equal((result as { status: number }).status, 200);
  } finally {
    stub.restore();
  }
});

test("an http to https redirect on an allowed host is followed", async () => {
  const stub = stubFetch([{ status: 301, location: "https://allowed.example/secure" }, { status: 200 }]);

  try {
    await httpTool.execute({ url: "http://allowed.example/start" }, context);
    assert.deepEqual(stub.requested, ["http://allowed.example/start", "https://allowed.example/secure"]);
  } finally {
    stub.restore();
  }
});

test("a relative redirect resolves against the host that sent it", async () => {
  const stub = stubFetch([{ status: 302, location: "/moved" }, { status: 200 }]);

  try {
    await httpTool.execute({ url: "https://allowed.example/start" }, context);
    assert.deepEqual(stub.requested, ["https://allowed.example/start", "https://allowed.example/moved"]);
  } finally {
    stub.restore();
  }
});

test("a redirect loop stops at the hop limit", async () => {
  // Every hop points at an allowed host, so only the cap can end this.
  const stub = stubFetch([{ status: 302, location: "https://allowed.example/again" }]);

  try {
    await assert.rejects(httpTool.execute({ url: "https://allowed.example/start" }, context), /Exceeded 5 redirects/);

    // The first request plus five followed hops.
    assert.equal(stub.requested.length, 6);
  } finally {
    stub.restore();
  }
});
