import type { MemoryStore, Message } from "@bugbaar/agents";
import type { Collection, Db } from "mongodb";

interface MessageDocument {
  sessionId: string;
  role: Message["role"];
  content: string;
  toolCalls?: Message["toolCalls"];
  toolCallId?: string;
  createdAt: Date;
  /** Monotonic within a session, so messages appended in one call keep their order. */
  sequence: number;
}

export interface MongoMemoryStoreOptions {
  collectionName?: string;
  /** Messages retained per session; older ones are trimmed on append. */
  maxMessagesPerSession?: number;
  /** Collection holding the per-session sequence counters. */
  counterCollectionName?: string;
}

interface CounterDocument {
  _id: string;
  next: number;
}

/**
 * MongoDB-backed conversation memory.
 *
 * Ordering is by an explicit `sequence` rather than `createdAt`: several
 * messages are appended in a single call and would otherwise share a
 * millisecond timestamp, leaving their order undefined.
 */
export class MongoMemoryStore implements MemoryStore {
  readonly #collection: Collection<MessageDocument>;
  readonly #counters: Collection<CounterDocument>;
  readonly #maxMessages: number;

  constructor(db: Db, options: MongoMemoryStoreOptions = {}) {
    this.#collection = db.collection<MessageDocument>(options.collectionName ?? "agent_messages");
    this.#counters = db.collection<CounterDocument>(options.counterCollectionName ?? "agent_message_counters");
    this.#maxMessages = options.maxMessagesPerSession ?? 500;
  }

  /** Creates the indexes this store depends on. Safe to call repeatedly. */
  async ensureIndexes(): Promise<void> {
    await this.#collection.createIndex({ sessionId: 1, sequence: 1 });
  }

  async append(sessionId: string, messages: Message[]): Promise<void> {
    if (messages.length === 0) return;

    let sequence = await this.#reserve(sessionId, messages.length);

    const documents: MessageDocument[] = messages.map((message) => ({
      sessionId,
      role: message.role,
      content: message.content,
      ...(message.toolCalls ? { toolCalls: message.toolCalls } : {}),
      ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
      createdAt: message.createdAt ? new Date(message.createdAt) : new Date(),
      sequence: sequence++,
    }));

    await this.#collection.insertMany(documents);
    await this.#trim(sessionId);
  }

  async history(sessionId: string, limit?: number): Promise<Message[]> {
    // Take the newest `limit` messages, then restore chronological order —
    // sorting ascending with a limit would return the oldest instead.
    const documents = await this.#collection
      .find({ sessionId })
      .sort({ sequence: -1 })
      .limit(limit ?? this.#maxMessages)
      .toArray();

    return documents.reverse().map(toMessage);
  }

  async clear(sessionId: string): Promise<void> {
    await this.#collection.deleteMany({ sessionId });
    // Reset the counter too, so a cleared session starts from zero rather than
    // carrying an ever-growing number nobody can see.
    await this.#counters.deleteOne({ _id: sessionId });
  }

  async sessions(): Promise<string[]> {
    return await this.#collection.distinct("sessionId");
  }

  /**
   * Reserves a contiguous block of sequence numbers, returning the first.
   *
   * Reading the highest existing sequence and adding one is a read-then-write
   * race: concurrent appends to the same session all observe the same value
   * and write duplicates. Ten simultaneous appends were measured landing on
   * sequences [0,0,0,0,0,0,0,0,1,1] — every message survived, but the
   * transcript order was destroyed.
   *
   * $inc is atomic on the server, so each caller gets a block nobody else
   * holds, and one round trip covers however many messages are being appended.
   */
  async #reserve(sessionId: string, count: number): Promise<number> {
    const counter = await this.#counters.findOneAndUpdate(
      { _id: sessionId },
      { $inc: { next: count } },
      { upsert: true, returnDocument: "after" },
    );

    const next = counter?.next ?? count;
    return next - count;
  }

  /** Drops the oldest messages once a session exceeds its cap. */
  async #trim(sessionId: string): Promise<void> {
    const count = await this.#collection.countDocuments({ sessionId });
    const excess = count - this.#maxMessages;
    if (excess <= 0) return;

    const stale = await this.#collection
      .find({ sessionId }, { sort: { sequence: 1 }, limit: excess, projection: { _id: 1 } })
      .toArray();

    await this.#collection.deleteMany({ _id: { $in: stale.map((document) => document._id) } });
  }
}

function toMessage(document: MessageDocument): Message {
  return {
    role: document.role,
    content: document.content,
    ...(document.toolCalls ? { toolCalls: document.toolCalls } : {}),
    ...(document.toolCallId ? { toolCallId: document.toolCallId } : {}),
    createdAt: document.createdAt.toISOString(),
  };
}
