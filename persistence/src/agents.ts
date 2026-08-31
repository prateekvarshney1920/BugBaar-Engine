import type { AgentDefinition, AgentRepository } from "@bugbaar/agents";
import type { Collection, Db } from "mongodb";

type AgentDocument = AgentDefinition & { _id: string };

/**
 * MongoDB-backed agent definitions.
 *
 * The agent id doubles as the `_id`, which gives uniqueness enforcement for
 * free and makes every lookup a primary-key hit.
 */
export class MongoAgentRepository implements AgentRepository {
  readonly #collection: Collection<AgentDocument>;

  constructor(db: Db, collectionName = "agents") {
    this.#collection = db.collection<AgentDocument>(collectionName);
  }

  async ensureIndexes(): Promise<void> {
    await this.#collection.createIndex({ createdAt: -1 });
  }

  async create(definition: AgentDefinition): Promise<boolean> {
    try {
      await this.#collection.insertOne({ ...definition, _id: definition.id });
      return true;
    } catch (error) {
      // 11000 is MongoDB's duplicate-key code. Letting the unique _id index
      // decide keeps creation atomic across every replica, which a
      // read-then-write check cannot be.
      if (isDuplicateKey(error)) return false;
      throw error;
    }
  }

  async save(definition: AgentDefinition): Promise<void> {
    // The replacement omits _id (the driver forbids it); on upsert MongoDB
    // takes the _id from the filter, so the agent id still becomes the key.
    await this.#collection.replaceOne({ _id: definition.id }, { ...definition }, { upsert: true });
  }

  async get(id: string): Promise<AgentDefinition | null> {
    const document = await this.#collection.findOne({ _id: id });
    return document ? toDefinition(document) : null;
  }

  async list(): Promise<AgentDefinition[]> {
    const documents = await this.#collection.find().sort({ createdAt: 1 }).toArray();
    return documents.map(toDefinition);
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.#collection.deleteOne({ _id: id });
    return result.deletedCount > 0;
  }
}

function toDefinition({ _id, ...definition }: AgentDocument): AgentDefinition {
  return definition;
}

function isDuplicateKey(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: number }).code === 11000;
}
