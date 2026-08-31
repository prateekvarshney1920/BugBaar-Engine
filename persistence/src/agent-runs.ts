import {
  toTraceSteps,
  type AgentRunRecord,
  type AgentRunStart,
  type AgentRunStore,
  type AgentRunResult,
  type RecentAgentRunsOptions,
} from "@bugbaar/agents";
import type { Collection, Db } from "mongodb";

/** The run id doubles as `_id`, which makes every lookup a primary-key hit. */
type AgentRunDocument = Omit<AgentRunRecord, "runId"> & { _id: string; startedAtDate: Date };

export interface MongoAgentRunStoreOptions {
  collectionName?: string;
  /**
   * Days to keep a run before MongoDB expires it. Run history is diagnostic
   * data that grows without bound, so expiry belongs in the schema rather than
   * in a cleanup job nobody writes. Set to 0 to retain forever.
   */
  retentionDays?: number;
}

/**
 * MongoDB-backed agent run history.
 *
 * `startedAt` is stored twice: as an ISO string for the record, and as a real
 * `Date` for indexing. Sorting and TTL expiry both need a BSON date, while the
 * API contract is a string — and converting on every read would mean sorting
 * lexicographically on a field the index cannot serve.
 */
export class MongoAgentRunStore implements AgentRunStore {
  readonly #collection: Collection<AgentRunDocument>;
  readonly #retentionDays: number;

  constructor(db: Db, options: MongoAgentRunStoreOptions = {}) {
    this.#collection = db.collection<AgentRunDocument>(options.collectionName ?? "agent_runs");
    this.#retentionDays = options.retentionDays ?? 30;
  }

  async ensureIndexes(): Promise<void> {
    await this.#collection.createIndex({ startedAtDate: -1 });
    await this.#collection.createIndex({ agentId: 1, startedAtDate: -1 });

    if (this.#retentionDays > 0) {
      await this.#collection.createIndex(
        { startedAtDate: 1 },
        { expireAfterSeconds: this.#retentionDays * 24 * 60 * 60, name: "agent_run_ttl" },
      );
    }
  }

  async start(run: AgentRunStart): Promise<void> {
    const startedAt = run.startedAt ?? new Date().toISOString();

    // Upsert rather than insert: a retried request reusing a run id should
    // not fail the run with a duplicate-key error.
    await this.#collection.replaceOne(
      { _id: run.runId },
      {
        agentId: run.agentId,
        input: run.input,
        ...(run.sessionId === undefined ? {} : { sessionId: run.sessionId }),
        status: "running",
        steps: [],
        startedAt,
        startedAtDate: new Date(startedAt),
      },
      { upsert: true },
    );
  }

  async complete(result: AgentRunResult): Promise<void> {
    const startedAt = new Date(Date.now() - result.durationMs).toISOString();

    await this.#collection.updateOne(
      { _id: result.runId },
      {
        $set: {
          status: "completed",
          stoppedBecause: result.stoppedBecause,
          output: result.output,
          steps: toTraceSteps(result.steps),
          finishedAt: new Date().toISOString(),
          durationMs: result.durationMs,
        },
        // Only applied when start() never landed — a persistence failure there
        // must not make the finished run invisible, which is precisely when
        // someone goes looking for it.
        $setOnInsert: {
          agentId: result.agentId,
          input: "",
          startedAt,
          startedAtDate: new Date(startedAt),
        },
      },
      { upsert: true },
    );
  }

  async fail(runId: string, error: string): Promise<void> {
    const existing = await this.#collection.findOne({ _id: runId }, { projection: { startedAt: 1 } });
    // A run nobody recorded starting cannot be failed; there is nothing to
    // describe, and inventing a record would be worse than omitting one.
    if (!existing) return;

    const finishedAt = new Date();

    await this.#collection.updateOne(
      { _id: runId },
      {
        $set: {
          status: "failed",
          error,
          finishedAt: finishedAt.toISOString(),
          durationMs: finishedAt.getTime() - Date.parse(existing.startedAt),
        },
      },
    );
  }

  async get(runId: string): Promise<AgentRunRecord | null> {
    const document = await this.#collection.findOne({ _id: runId });
    return document ? toRecord(document) : null;
  }

  async recent(limit = 50, options: RecentAgentRunsOptions = {}): Promise<AgentRunRecord[]> {
    const documents = await this.#collection
      .find(options.agentId ? { agentId: options.agentId } : {})
      .sort({ startedAtDate: -1 })
      .limit(limit)
      .toArray();

    return documents.map(toRecord);
  }
}

function toRecord({ _id, startedAtDate, ...record }: AgentRunDocument): AgentRunRecord {
  return { runId: _id, ...record };
}
