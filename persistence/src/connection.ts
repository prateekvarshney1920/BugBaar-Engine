import { MongoClient, type Db } from "mongodb";

export interface MongoConnectionOptions {
  uri: string;
  /** Defaults to the database named in the URI. */
  database?: string;
  /** Attempts made before `connect()` gives up. */
  maxAttempts?: number;
  retryDelayMs?: number;
  /** How long a single connection attempt may take. */
  connectTimeoutMs?: number;
  onLog?: (message: string, data?: Record<string, unknown>) => void;
}

/**
 * Owns the MongoDB client lifecycle.
 *
 * Connection is retried with exponential backoff because a container starting
 * alongside MongoDB routinely wins the race — failing permanently on the first
 * refused socket would make the engine unstartable in Compose and Kubernetes
 * for no good reason.
 */
export class MongoConnection {
  #client: MongoClient | null = null;
  #db: Db | null = null;
  readonly #options: Required<Omit<MongoConnectionOptions, "database" | "onLog">> &
    Pick<MongoConnectionOptions, "database" | "onLog">;

  constructor(options: MongoConnectionOptions) {
    this.#options = {
      uri: options.uri,
      database: options.database,
      maxAttempts: options.maxAttempts ?? 5,
      retryDelayMs: options.retryDelayMs ?? 500,
      connectTimeoutMs: options.connectTimeoutMs ?? 5_000,
      onLog: options.onLog,
    };
  }

  get connected(): boolean {
    return this.#db !== null;
  }

  /** Returns the database handle, throwing if `connect()` has not succeeded. */
  db(): Db {
    if (!this.#db) throw new Error("MongoConnection is not connected — call connect() first");
    return this.#db;
  }

  async connect(): Promise<Db> {
    if (this.#db) return this.#db;

    const { maxAttempts, retryDelayMs, connectTimeoutMs, uri, database, onLog } = this.#options;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const client = new MongoClient(uri, {
          connectTimeoutMS: connectTimeoutMs,
          serverSelectionTimeoutMS: connectTimeoutMs,
        });
        await client.connect();

        this.#client = client;
        this.#db = database ? client.db(database) : client.db();
        onLog?.("connected to MongoDB", { database: this.#db.databaseName, attempt });
        return this.#db;
      } catch (error) {
        lastError = error;
        if (attempt === maxAttempts) break;

        const delay = retryDelayMs * 2 ** (attempt - 1);
        onLog?.(`MongoDB connection attempt ${attempt} failed, retrying in ${delay}ms`, {
          error: error instanceof Error ? error.message : String(error),
        });
        await sleep(delay);
      }
    }

    throw new Error(
      `Could not connect to MongoDB after ${maxAttempts} attempts: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    );
  }

  /** Cheap liveness probe for the health endpoint. */
  async ping(): Promise<boolean> {
    if (!this.#db) return false;
    try {
      await this.#db.command({ ping: 1 });
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.#client?.close();
    this.#client = null;
    this.#db = null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
