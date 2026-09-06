import type { Tool } from "./types.js";

/** Deterministic arithmetic — useful as a smoke test and as an agent example. */
export const calculatorTool: Tool<{ a: number; b: number; operation: string }, number> = {
  name: "calculator",
  description: "Perform a basic arithmetic operation on two numbers.",
  parameters: {
    type: "object",
    properties: {
      a: { type: "number", description: "Left operand" },
      b: { type: "number", description: "Right operand" },
      operation: {
        type: "string",
        description: "Arithmetic operation to apply",
        enum: ["add", "subtract", "multiply", "divide"],
      },
    },
    required: ["a", "b", "operation"],
    additionalProperties: false,
  },
  async execute({ a, b, operation }) {
    switch (operation) {
      case "add":
        return a + b;
      case "subtract":
        return a - b;
      case "multiply":
        return a * b;
      case "divide":
        if (b === 0) throw new Error("Division by zero");
        return a / b;
      default:
        throw new Error(`Unsupported operation "${operation}"`);
    }
  },
};

/** Redirect hops the http tool will follow before giving up. */
const MAX_REDIRECTS = 5;

/** Statuses that carry a `Location` worth following. 304 and 305 do not. */
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

export interface HttpToolOptions {
  /** Hostnames the tool is permitted to reach. Empty means "deny everything". */
  allowedHosts: string[];
  timeoutMs?: number;
}

/**
 * Outbound HTTP for agents, restricted to an explicit host allowlist.
 *
 * The allowlist is mandatory: an agent that can be steered by untrusted text
 * must not be able to reach arbitrary URLs (SSRF / exfiltration).
 */
export function createHttpTool(options: HttpToolOptions): Tool<{ url: string; method?: string }, unknown> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const allowed = new Set(options.allowedHosts.map((host) => host.toLowerCase()));

  /** The protocol and host gate, applied to the first URL and to every hop after it. */
  function assertAllowed(target: URL): void {
    if (target.protocol !== "https:" && target.protocol !== "http:") {
      throw new Error(`Unsupported protocol "${target.protocol}"`);
    }
    if (!allowed.has(target.hostname.toLowerCase())) {
      throw new Error(`Host "${target.hostname}" is not on the allowlist`);
    }
  }

  return {
    name: "http_request",
    description: "Fetch a URL from an approved host and return its response body.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute http(s) URL to request" },
        method: { type: "string", description: "HTTP method", enum: ["GET", "HEAD"], default: "GET" },
      },
      required: ["url"],
      additionalProperties: false,
    },
    async execute({ url, method = "GET" }, context) {
      let target: URL;
      try {
        target = new URL(url);
      } catch {
        throw new Error(`"${url}" is not a valid absolute URL`);
      }

      assertAllowed(target);

      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = context.signal ? AbortSignal.any([context.signal, timeout]) : timeout;

      /*
       * Redirects are followed by hand.
       *
       * With fetch's default `redirect: "follow"` the allowlist only guards
       * the first hop: one 302 from an allowed host reaches anything the
       * network can — cloud metadata, internal services — which is the SSRF
       * the allowlist exists to prevent. Every hop is validated here, before
       * its request is made.
       */
      let response = await fetch(target, { method, redirect: "manual", signal });

      for (let hop = 0; isRedirect(response); hop += 1) {
        if (hop >= MAX_REDIRECTS) {
          throw new Error(`Exceeded ${MAX_REDIRECTS} redirects starting from "${url}"`);
        }

        // A 3xx without a Location is not a redirect; return it as the result.
        const location = response.headers.get("location");
        if (!location) break;

        let next: URL;
        try {
          // Resolved against the current hop, so a relative Location lands on
          // the host that sent it rather than on the original URL.
          next = new URL(location, target);
        } catch {
          throw new Error(`Redirect target "${location}" is not a valid URL`);
        }

        assertAllowed(next);
        target = next;
        response = await fetch(target, { method, redirect: "manual", signal });
      }

      const body = await response.text();

      return {
        status: response.status,
        contentType: response.headers.get("content-type"),
        body: body.slice(0, 100_000),
      };
    },
  };
}

function isRedirect(response: Response): boolean {
  return REDIRECT_STATUS.has(response.status);
}
