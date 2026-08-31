import type { AgentRepository, AgentRunStore, MemoryStore } from "@bugbaar/agents";
import type { WorkflowRunStore } from "@bugbaar/workflows";
import { MongoAgentRunStore } from "./agent-runs.js";
import { MongoAgentRepository } from "./agents.js";
import { MongoConnection, type MongoConnectionOptions } from "./connection.js";
import { MongoMemoryStore } from "./memory.js";
import { MongoWorkflowRunStore } from "./runs.js";

export interface PersistenceLayer {
  connection: MongoConnection;
  memory: MemoryStore;
  agents: AgentRepository;
  runs: WorkflowRunStore;
  agentRuns: AgentRunStore;
  close(): Promise<void>;
}

export interface CreatePersistenceOptions extends MongoConnectionOptions {
  retentionDays?: number;
  maxMessagesPerSession?: number;
}

/**
 * Connects to MongoDB and returns every store, with indexes in place.
 *
 * Index creation happens once at boot rather than lazily per query: it is
 * idempotent, and a missing index should surface as a startup failure instead
 * of as a slow collection scan discovered in production.
 */
export async function createPersistence(options: CreatePersistenceOptions): Promise<PersistenceLayer> {
  const connection = new MongoConnection(options);
  const db = await connection.connect();

  const memory = new MongoMemoryStore(db, { maxMessagesPerSession: options.maxMessagesPerSession });
  const agents = new MongoAgentRepository(db);
  const runs = new MongoWorkflowRunStore(db, { retentionDays: options.retentionDays });
  const agentRuns = new MongoAgentRunStore(db, { retentionDays: options.retentionDays });

  await Promise.all([
    memory.ensureIndexes(),
    agents.ensureIndexes(),
    runs.ensureIndexes(),
    agentRuns.ensureIndexes(),
  ]);

  return {
    connection,
    memory,
    agents,
    runs,
    agentRuns,
    close: () => connection.close(),
  };
}
