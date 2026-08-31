import type { WorkflowRun, WorkflowRunStore } from "@bugbaar/workflows";
import type { Collection, Db } from "mongodb";

type RunDocument = WorkflowRun & { _id: string; recordedAt: Date };

export interface MongoRunStoreOptions {
  collectionName?: string;
  /**
   * Days to keep a run before MongoDB expires it. Run history is diagnostic
   * data that grows without bound, so it gets a TTL rather than manual
   * cleanup. Set to 0 to retain forever.
   */
  retentionDays?: number;
}

/** MongoDB-backed workflow run history. */
export class MongoWorkflowRunStore implements WorkflowRunStore {
  readonly #collection: Collection<RunDocument>;
  readonly #retentionDays: number;

  constructor(db: Db, options: MongoRunStoreOptions = {}) {
    this.#collection = db.collection<RunDocument>(options.collectionName ?? "workflow_runs");
    this.#retentionDays = options.retentionDays ?? 30;
  }

  async ensureIndexes(): Promise<void> {
    await this.#collection.createIndex({ recordedAt: -1 });
    await this.#collection.createIndex({ workflow: 1, recordedAt: -1 });

    if (this.#retentionDays > 0) {
      await this.#collection.createIndex(
        { recordedAt: 1 },
        { expireAfterSeconds: this.#retentionDays * 24 * 60 * 60, name: "run_ttl" },
      );
    }
  }

  async record(run: WorkflowRun): Promise<void> {
    await this.#collection.insertOne({ ...run, _id: run.runId, recordedAt: new Date() });
  }

  async recent(limit = 50): Promise<WorkflowRun[]> {
    const documents = await this.#collection.find().sort({ recordedAt: -1 }).limit(limit).toArray();
    return documents.map(toRun);
  }

  async get(runId: string): Promise<WorkflowRun | null> {
    const document = await this.#collection.findOne({ _id: runId });
    return document ? toRun(document) : null;
  }
}

function toRun({ _id, recordedAt, ...run }: RunDocument): WorkflowRun {
  return run;
}
