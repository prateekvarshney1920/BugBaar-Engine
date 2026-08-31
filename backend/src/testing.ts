import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "./app.js";
import { loadConfig, type Config } from "./config/index.js";
import { createLogger } from "./config/logger.js";
import { Container } from "./services/container.js";
import { registerExamples } from "./services/examples.js";

export interface TestHarness {
  container: Container;
  config: Config;
  baseUrl: string;
  /** Issues a request against the running app. Adds the API key by default. */
  request(path: string, init?: RequestInit & { apiKey?: string | null }): Promise<Response>;
  /** Convenience for the common case: send JSON, get parsed JSON plus status. */
  json<T = unknown>(
    path: string,
    init?: RequestInit & { apiKey?: string | null },
  ): Promise<{ status: number; body: T; headers: Headers }>;
  close(): Promise<void>;
}

export interface HarnessOptions {
  /** Environment overrides applied for the lifetime of the harness. */
  env?: Record<string, string | undefined>;
  /** Seed the example agent and workflow. Defaults to true. */
  seed?: boolean;
}

const TEST_API_KEY = "test-key";

/**
 * Boots the real Express app on an ephemeral port for testing.
 *
 * It binds a real socket rather than injecting into the router because the
 * behaviour worth testing lives in the middleware chain — auth, rate limiting,
 * body parsing, headers, the error envelope. A harness that bypasses HTTP
 * would skip exactly the layer most likely to break.
 *
 * Everything is in-memory: no MongoDB, no Redis, no network.
 */
export async function createHarness(options: HarnessOptions = {}): Promise<TestHarness> {
  const previous = new Map<string, string | undefined>();
  const overrides: Record<string, string | undefined> = {
    NODE_ENV: "test",
    API_KEYS: TEST_API_KEY,
    LOG_LEVEL: "error",
    MONGODB_URI: "",
    REDIS_URL: "",
    QDRANT_URL: "",
    OPENAI_API_KEY: "",
    LLM_PROVIDER: "echo",
    ...options.env,
  };

  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  const config = loadConfig();
  const logger = createLogger(config.logLevel, { service: "test" });
  const container = new Container(config, logger);

  await container.ready();
  if (options.seed !== false) await registerExamples(container);

  const app = createApp(container, config, logger);
  const server: Server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });

  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  const request = (path: string, init: RequestInit & { apiKey?: string | null } = {}): Promise<Response> => {
    const { apiKey, ...rest } = init;
    const headers = new Headers(rest.headers);

    // apiKey: null means "send no key at all", for testing the 401 path.
    if (apiKey !== null) headers.set("x-api-key", apiKey ?? TEST_API_KEY);
    if (rest.body !== undefined && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }

    return fetch(`${baseUrl}${path}`, { ...rest, headers });
  };

  return {
    container,
    config,
    baseUrl,
    request,
    async json<T>(path: string, init: RequestInit & { apiKey?: string | null } = {}) {
      const response = await request(path, init);
      const text = await response.text();
      return {
        status: response.status,
        headers: response.headers,
        body: (text ? JSON.parse(text) : null) as T,
      };
    },
    async close() {
      // Same order as production shutdown: end streams, then wait for the
      // server. Reversed, an open stream would hang the close forever.
      container.streams.closeAll();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await container.shutdown();

      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

export { TEST_API_KEY };

/** Shorthand for a JSON POST body. */
export function post(body: unknown): RequestInit {
  return { method: "POST", body: JSON.stringify(body) };
}
