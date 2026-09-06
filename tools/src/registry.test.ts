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

/*
 * The body cap has to bound memory, not just the returned string.
 *
 * `response.text()` buffers the whole body and truncates afterwards, so an
 * agent pointed at a huge or endless response allocates all of it first. The
 * stub below streams a body in chunks and counts how many bytes were actually
 * pulled, which is what separates "the answer is short" from "we never read
 * the rest".
 */

interface StubBody {
  /** Total bytes the origin is willing to serve. */
  size: number;
  status?: number;
  contentType?: string;
  /** Byte value repeated to fill the body. Defaults to "a". */
  fill?: string;
}

const CHUNK = 8_192;

/** Serves a body in chunks, recording how many bytes the caller consumed. */
function stubBody(spec: StubBody): { pulled: () => number; restore: () => void } {
  const realFetch = globalThis.fetch;
  let pulled = 0;

  globalThis.fetch = async () => {
    let sent = 0;
    const unit = new TextEncoder().encode(spec.fill ?? "a");

    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= spec.size) {
          controller.close();
          return;
        }
        const bytes = Math.min(CHUNK, spec.size - sent);
        const chunk = new Uint8Array(bytes);
        // Continue the pattern across chunks; restarting it per chunk would
        // emit invalid UTF-8 for a multi-byte fill.
        for (let i = 0; i < bytes; i += 1) chunk[i] = unit[(sent + i) % unit.length]!;
        sent += bytes;
        pulled += bytes;
        controller.enqueue(chunk);
      },
    });

    return new Response(stream, {
      status: spec.status ?? 200,
      headers: { "content-type": spec.contentType ?? "text/plain" },
    });
  };

  return { pulled: () => pulled, restore: () => (globalThis.fetch = realFetch) };
}

const fetchBody = async (): Promise<{ status: number; contentType: string | null; body: string }> =>
  (await httpTool.execute({ url: "https://allowed.example/doc" }, context)) as {
    status: number;
    contentType: string | null;
    body: string;
  };

test("an oversized response is capped without buffering the whole body", async () => {
  const FIVE_MB = 5_000_000;
  const stub = stubBody({ size: FIVE_MB });

  try {
    const result = await fetchBody();

    assert.equal(Buffer.byteLength(result.body, "utf8"), 100_000, "the body is capped at 100 KB");

    // The security property: the rest of the response was never read. Two
    // chunks of slack — one to cross the cap, one more because a stream with
    // the default highWaterMark pre-pulls the next chunk.
    assert.ok(
      stub.pulled() <= 100_000 + 2 * CHUNK,
      `only the capped prefix should be pulled, but ${stub.pulled()} bytes were read`,
    );
    assert.ok(stub.pulled() < FIVE_MB, "the full body must never be buffered");
  } finally {
    stub.restore();
  }
});

test("a body exactly at the cap is returned whole", async () => {
  const stub = stubBody({ size: 100_000 });

  try {
    const result = await fetchBody();
    assert.equal(Buffer.byteLength(result.body, "utf8"), 100_000);
    assert.equal(result.body.includes("�"), false, "nothing was cut mid-character");
  } finally {
    stub.restore();
  }
});

test("a normal response is returned unchanged", async () => {
  const stub = stubBody({ size: 11, fill: "hello world", status: 201, contentType: "application/json" });

  try {
    const result = await fetchBody();

    assert.equal(result.status, 201);
    assert.equal(result.contentType, "application/json");
    assert.equal(result.body, "hello world");
  } finally {
    stub.restore();
  }
});

test("multibyte content is capped by bytes and truncation does not throw", async () => {
  // Three bytes per character, so the cap lands mid-character.
  const stub = stubBody({ size: 300_000, fill: "€" });

  try {
    const result = await fetchBody();
    const bytes = Buffer.byteLength(result.body, "utf8");

    /*
     * Reading stops at exactly 100,000 bytes, which lands mid-character here.
     * Decoding turns the 1-2 orphaned bytes into a single U+FFFD, and that is
     * 3 bytes of UTF-8 — so the decoded string can sit up to 2 bytes past the
     * cap. What is bounded is what was read, which is what bounds memory.
     */
    assert.ok(bytes <= 100_000 + 2, `expected at most 100002 bytes, got ${bytes}`);
    assert.ok(bytes > 99_000, "and the cap is by bytes, not characters");
    assert.ok(result.body.startsWith("€€"), "the intact prefix survives");
  } finally {
    stub.restore();
  }
});

test("a response with no body yields an empty string", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 204 });

  try {
    const result = await fetchBody();
    assert.equal(result.status, 204);
    assert.equal(result.body, "");
  } finally {
    globalThis.fetch = realFetch;
  }
});
