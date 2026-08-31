import {
  Agent,
  EchoProvider,
  InMemoryAgentRepository,
  InMemoryAgentRunStore,
  InMemoryStore,
  OpenAiProvider,
  type AgentDefinition,
  type AgentEvent,
  type AgentRepository,
  type AgentRunResult,
  type AgentRunStep,
  type AgentRunStore,
  type LlmProvider,
  type MemoryStore,
} from "@bugbaar/agents";
import { createPersistence, type PersistenceLayer } from "@bugbaar/persistence";
import { createQueue, type QueueLayer } from "@bugbaar/queue";
import {
  HashingEmbeddingProvider,
  InMemoryVectorStore,
  OpenAiEmbeddingProvider,
  QdrantVectorStore,
  RagPipeline,
  type EmbeddingProvider,
  type VectorStore,
} from "@bugbaar/rag";
import { calculatorTool, ToolRegistry, type Tool } from "@bugbaar/tools";
import {
  EventBus,
  InMemoryJobQueue,
  InMemoryRateLimiter,
  InMemoryRunStore,
  type Workflow,
  type JobQueue,
  type RateLimiter,
  type WorkflowRun,
  type WorkflowRunStore,
} from "@bugbaar/workflows";
import type { Config } from "../config/index.js";
import type { Logger } from "../config/logger.js";
import { Metrics } from "../observability/metrics.js";
import { StreamRegistry } from "./streams.js";

export type DependencyStatus = "up" | "down" | "not_configured";

/**
 * Wires the runtime together.
 *
 * Every dependency is resolved from config in one place, so swapping the
 * in-memory stores for Mongo/Qdrant is a configuration change rather than a
 * code change in the route handlers.
 */
export class Container {
  readonly agents = new Map<string, Agent>();
  readonly workflows = new Map<string, Workflow<Record<string, unknown>>>();
  readonly events: EventBus;
  readonly rag: RagPipeline;
  /** Open SSE responses, ended during shutdown so they cannot block it. */
  readonly streams = new StreamRegistry();
  readonly metrics: Metrics;
  readonly startedAt = Date.now();

  // Assigned during ready(); in-memory defaults keep the engine usable when
  // MONGODB_URI is unset.
  #memory: MemoryStore = new InMemoryStore();
  #agentRepository: AgentRepository = new InMemoryAgentRepository();
  #runStore: WorkflowRunStore = new InMemoryRunStore();
  #agentRunStore: AgentRunStore = new InMemoryAgentRunStore();
  #persistence: PersistenceLayer | null = null;
  #queueLayer: QueueLayer | null = null;
  #jobs: JobQueue;
  #rateLimiter: RateLimiter;

  readonly provider: LlmProvider;
  readonly #vectorStore: VectorStore;
  readonly #toolCatalog = new Map<string, Tool>();

  constructor(
    readonly config: Config,
    readonly logger: Logger,
  ) {
    this.metrics = new Metrics({ defaultMetrics: config.metrics.defaultMetrics });
    this.provider = createLlmProvider(config, logger);

    const embeddings = createEmbeddingProvider(config, logger);
    this.#vectorStore = createVectorStore(config, embeddings, logger);
    this.rag = new RagPipeline({ embeddings, store: this.#vectorStore });

    this.events = new EventBus((error, eventName) =>
      logger.error("event handler failed", { eventName, error: String(error) }),
    );
    this.#jobs = new InMemoryJobQueue({
      runner: (workflow, input) => this.runWorkflow(workflow, input),
      onComplete: (run, jobId) => this.#onJobRun(run, jobId),
      onError: (error, jobId) => logger.error("job failed", { jobId, error: String(error) }),
    });
    this.#rateLimiter = new InMemoryRateLimiter(config.rateLimit);

    this.registerTool(calculatorTool);
  }

  get memory(): MemoryStore {
    return this.#memory;
  }

  get agentRepository(): AgentRepository {
    return this.#agentRepository;
  }

  get runStore(): WorkflowRunStore {
    return this.#runStore;
  }

  get agentRunStore(): AgentRunStore {
    return this.#agentRunStore;
  }

  get persistent(): boolean {
    return this.#persistence !== null;
  }

  get jobs(): JobQueue {
    return this.#jobs;
  }

  get rateLimiter(): RateLimiter {
    return this.#rateLimiter;
  }

  /**
   * Executes a registered workflow and records the run.
   *
   * Both the synchronous route and the queue worker go through here, so a run
   * lands in history identically whichever path triggered it.
   */
  async runWorkflow(name: string, input: Record<string, unknown>): Promise<WorkflowRun> {
    const workflow = this.workflows.get(name);
    if (!workflow) throw new Error(`Unknown workflow "${name}"`);

    const run = await workflow.execute(input);

    this.metrics.observeWorkflowRun(run);
    await this.#runStore.record(run);
    await this.events.emit("workflow.run.completed", { workflow: name, status: run.status });
    return run;
  }

  /**
   * Records a finished agent run.
   *
   * Called from both the blocking and streaming routes, so the numbers cover
   * every run regardless of how it was triggered.
   */
  observeAgentRun(run: { agentId: string; stoppedBecause: string; durationMs: number; steps: AgentRunStep[] }): void {
    this.metrics.agentRuns.inc({ agent: run.agentId, outcome: run.stoppedBecause });
    this.metrics.agentRunDuration.observe({ agent: run.agentId }, run.durationMs / 1000);
    this.metrics.agentSteps.observe({ agent: run.agentId }, run.steps.length);

    for (const step of run.steps) {
      for (const tool of step.toolResults) {
        this.metrics.toolCalls.inc({ tool: tool.name, outcome: tool.ok ? "ok" : "error" });
        this.metrics.toolDuration.observe({ tool: tool.name }, tool.durationMs / 1000);
      }
    }
  }

  /**
   * Returns an event observer that records the run's lifecycle as it happens.
   *
   * Handed to `Agent.run()` and `Agent.stream()` alike, so both paths persist
   * identically rather than each wiring its own bookkeeping.
   *
   * The `run-start` write is fire-and-forget: making a caller wait on history
   * before the model is even asked would add latency to every request for no
   * benefit, and a lost start record self-heals when the run completes.
   */
  agentRunRecorder(context: { sessionId?: string } = {}): (event: AgentEvent) => void {
    return (event) => {
      if (event.type !== "run-start") return;

      void this.#persistAgentRun("start", event.runId, () =>
        this.#agentRunStore.start({
          runId: event.runId,
          agentId: event.agentId,
          input: event.input,
          ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
        }),
      );
    };
  }

  /** Records a finished run. Awaited, so the record exists before the response. */
  async completeAgentRun(result: AgentRunResult): Promise<void> {
    await this.#persistAgentRun("complete", result.runId, () => this.#agentRunStore.complete(result));
  }

  /** Records a run that could not finish. */
  async failAgentRun(runId: string, error: string): Promise<void> {
    await this.#persistAgentRun("fail", runId, () => this.#agentRunStore.fail(runId, error));
  }

  /**
   * Runs a history write without letting it break the run it describes.
   *
   * An agent run that produced a real answer must not be turned into a failure
   * because the audit record could not be written — that trades a working
   * feature for a broken one. But it must not be silent either, so a failure is
   * logged at error level and counted, which is how everything else in this
   * service surfaces a problem.
   */
  async #persistAgentRun(phase: string, runId: string, write: () => Promise<void>): Promise<void> {
    try {
      await write();
    } catch (error) {
      this.metrics.agentRunPersistenceFailures.inc({ phase });
      this.logger.error("could not persist agent run", {
        phase,
        runId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  #onJobRun(run: WorkflowRun, jobId: string): void {
    this.logger.info("queued workflow finished", {
      jobId,
      workflow: run.workflow,
      status: run.status,
      durationMs: run.durationMs,
    });
  }

  registerTool(tool: Tool): void {
    this.#toolCatalog.set(tool.name, tool);
  }

  toolCatalog(): Tool[] {
    return [...this.#toolCatalog.values()];
  }

  /** Builds a registry limited to the named tools; unknown names are rejected. */
  registryFor(names: string[] | undefined): ToolRegistry {
    const registry = new ToolRegistry();
    for (const name of names ?? []) {
      const tool = this.#toolCatalog.get(name);
      if (!tool) throw new Error(`Unknown tool "${name}"`);
      registry.register(tool);
    }
    return registry;
  }

  /** Rebuilds a live agent from its stored definition and registers it. */
  materialise(definition: AgentDefinition): Agent {
    const agent = new Agent({
      id: definition.id,
      name: definition.name,
      goal: definition.goal,
      instructions: definition.instructions,
      maxSteps: definition.maxSteps,
      temperature: definition.temperature,
      provider: this.provider,
      memory: this.#memory,
      tools: this.registryFor(definition.tools),
    });

    this.agents.set(definition.id, agent);
    return agent;
  }

  async ready(): Promise<void> {
    if (this.config.mongodbUri) {
      this.#persistence = await createPersistence({
        uri: this.config.mongodbUri,
        retentionDays: this.config.runRetentionDays,
        onLog: (message, data) => this.logger.info(message, data),
      });
      this.#memory = this.#persistence.memory;
      this.#agentRepository = this.#persistence.agents;
      this.#runStore = this.#persistence.runs;
      this.#agentRunStore = this.#persistence.agentRuns;
    } else {
      this.logger.warn("MONGODB_URI not set — agents, memory, and run history are in-memory and lost on restart");
    }

    if (this.config.redisUrl) {
      this.#queueLayer = await createQueue({
        url: this.config.redisUrl,
        queueName: this.config.queue.name,
        concurrency: this.config.queue.concurrency,
        startWorker: this.config.queue.startWorker,
        rateLimit: this.config.rateLimit,
        // The worker resolves the workflow by name at execution time, so jobs
        // queued before this process registered its workflows still run.
        runner: (workflow, input) => this.runWorkflow(workflow, input),
        onLog: (message, data) => this.logger.info(message, data),
        onRun: (run, jobId) => this.#onJobRun(run, jobId),
        onError: (error, jobId) => this.logger.error("job failed", { jobId, error: error.message }),
      });

      await this.#jobs.close();
      this.#jobs = this.#queueLayer.queue;
      this.#rateLimiter = this.#queueLayer.rateLimiter;
    } else {
      this.logger.warn(
        "REDIS_URL not set — background jobs run on in-process timers and rate limits are per-replica",
      );
    }

    if (this.#vectorStore instanceof QdrantVectorStore) {
      await this.#vectorStore.ensureCollection();
      this.logger.info("qdrant collection ready", { collection: this.config.qdrant.collection });
    }

    await this.#restoreAgents();
  }

  /**
   * Rebuilds every stored agent at boot.
   *
   * A definition can outlive the tool that satisfied it — a tool removed from
   * the catalogue between deploys would otherwise throw here and take down
   * startup. Log and skip instead, so one stale agent cannot block the rest.
   */
  async #restoreAgents(): Promise<void> {
    const definitions = await this.#agentRepository.list();
    let restored = 0;

    for (const definition of definitions) {
      try {
        this.materialise(definition);
        restored += 1;
      } catch (error) {
        this.logger.error("could not restore agent", {
          agentId: definition.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (definitions.length > 0) {
      this.logger.info("restored agents from storage", { restored, total: definitions.length });
    }
  }

  async shutdown(): Promise<void> {
    // Streams first: they never end on their own, so anything waiting on open
    // connections would wait forever.
    const closed = this.streams.closeAll();
    if (closed > 0) this.logger.info("closed open streams", { count: closed });

    await this.#jobs.close();
    await this.#queueLayer?.close();
    await this.#persistence?.close();
  }

  async dependencyStatus(): Promise<Record<string, DependencyStatus>> {
    return {
      mongodb: this.#persistence ? ((await this.#persistence.connection.ping()) ? "up" : "down") : "not_configured",
      redis: this.#queueLayer ? ((await this.#queueLayer.ping()) ? "up" : "down") : "not_configured",
      qdrant: this.config.qdrant.url ? "up" : "not_configured",
      llm: this.provider.name === "echo" ? "not_configured" : "up",
    };
  }
}

function createLlmProvider(config: Config, logger: Logger): LlmProvider {
  switch (config.llm.provider) {
    case "openai":
      return new OpenAiProvider({ apiKey: config.llm.openAiApiKey ?? "", model: config.llm.openAiModel });
    case "ollama":
      // Ollama exposes an OpenAI-compatible endpoint; the key is ignored.
      return new OpenAiProvider({
        apiKey: "ollama",
        model: config.llm.ollamaModel,
        baseUrl: `${config.llm.ollamaBaseUrl}/v1`,
      });
    default:
      logger.warn("using the echo LLM provider — set LLM_PROVIDER for real completions");
      return new EchoProvider(config.llm.echoChunkDelayMs);
  }
}

function createEmbeddingProvider(config: Config, logger: Logger): EmbeddingProvider {
  if (config.llm.openAiApiKey) {
    return new OpenAiEmbeddingProvider({ apiKey: config.llm.openAiApiKey });
  }
  logger.warn("using the hashing embedding provider — retrieval quality will be low");
  return new HashingEmbeddingProvider();
}

function createVectorStore(config: Config, embeddings: EmbeddingProvider, logger: Logger): VectorStore {
  if (!config.qdrant.url) {
    logger.warn("QDRANT_URL not set — using the in-memory vector store (data is lost on restart)");
    return new InMemoryVectorStore();
  }
  return new QdrantVectorStore({
    url: config.qdrant.url,
    apiKey: config.qdrant.apiKey,
    collection: config.qdrant.collection,
    dimensions: embeddings.dimensions,
  });
}
