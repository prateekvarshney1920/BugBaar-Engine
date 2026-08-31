/**
 * Environment configuration, read once at boot and validated eagerly so a
 * misconfigured deployment fails at startup rather than on first request.
 */
export interface Config {
  env: "development" | "test" | "production";
  port: number;
  logLevel: "debug" | "info" | "warn" | "error";
  apiKeys: string[];
  corsOrigin: string;
  /** Seed the example agent and workflow at boot. */
  seedExamples: boolean;
  metrics: {
    /** Expose /metrics. */
    enabled: boolean;
    /** Include process, heap, and event-loop metrics. */
    defaultMetrics: boolean;
  };
  rateLimit: { windowMs: number; max: number };
  mongodbUri?: string;
  /** Days of workflow run history to keep; 0 retains forever. */
  runRetentionDays: number;
  redisUrl?: string;
  queue: {
    name: string;
    concurrency: number;
    /** Run a worker in this process. Set false for an API-only tier. */
    startWorker: boolean;
  };
  qdrant: { url?: string; apiKey?: string; collection: string };
  llm: {
    provider: "echo" | "openai" | "ollama";
    openAiApiKey?: string;
    openAiModel: string;
    ollamaBaseUrl: string;
    ollamaModel: string;
    /** Per-word delay for the echo provider's synthetic stream. Testing aid. */
    echoChunkDelayMs: number;
  };
}

function readNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number, received "${raw}"`);
  return value;
}

function readList(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function loadConfig(): Config {
  const env = (process.env.NODE_ENV ?? "development") as Config["env"];
  const apiKeys = readList("API_KEYS");
  const provider = (process.env.LLM_PROVIDER ?? "echo") as Config["llm"]["provider"];

  // An unauthenticated gateway is a production outage waiting to happen, so
  // refuse to boot without keys rather than silently allowing anonymous access.
  if (env === "production" && apiKeys.length === 0) {
    throw new Error("API_KEYS must be set in production");
  }
  if (provider === "openai" && !process.env.OPENAI_API_KEY) {
    throw new Error('LLM_PROVIDER="openai" requires OPENAI_API_KEY');
  }

  return {
    env,
    port: readNumber("PORT", 4000),
    logLevel: (process.env.LOG_LEVEL ?? "info") as Config["logLevel"],
    apiKeys,
    corsOrigin: process.env.CORS_ORIGIN ?? "*",
    seedExamples: (process.env.SEED_EXAMPLES ?? "true").toLowerCase() !== "false",
    metrics: {
      enabled: (process.env.METRICS_ENABLED ?? "true").toLowerCase() !== "false",
      defaultMetrics: (process.env.METRICS_DEFAULT ?? "true").toLowerCase() !== "false",
    },
    rateLimit: {
      windowMs: readNumber("RATE_LIMIT_WINDOW_MS", 60_000),
      max: readNumber("RATE_LIMIT_MAX", 120),
    },
    mongodbUri: process.env.MONGODB_URI || undefined,
    runRetentionDays: readNumber("RUN_RETENTION_DAYS", 30),
    redisUrl: process.env.REDIS_URL || undefined,
    queue: {
      name: process.env.QUEUE_NAME ?? "bugbaar-workflows",
      concurrency: readNumber("QUEUE_CONCURRENCY", 4),
      startWorker: (process.env.QUEUE_START_WORKER ?? "true").toLowerCase() !== "false",
    },
    qdrant: {
      url: process.env.QDRANT_URL || undefined,
      apiKey: process.env.QDRANT_API_KEY || undefined,
      collection: process.env.QDRANT_COLLECTION ?? "bugbaar_knowledge",
    },
    llm: {
      provider,
      openAiApiKey: process.env.OPENAI_API_KEY || undefined,
      openAiModel: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
      ollamaBaseUrl: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
      ollamaModel: process.env.OLLAMA_MODEL ?? "llama3.1",
      echoChunkDelayMs: readNumber("ECHO_CHUNK_DELAY_MS", 0),
    },
  };
}
