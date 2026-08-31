/**
 * Agent definitions, separated from the runtime `Agent` class.
 *
 * An `Agent` holds live dependencies — a provider, a tool registry, a memory
 * store — none of which can be serialised. A definition is the part that can:
 * enough to rebuild the agent after a restart, and nothing more.
 */
export interface AgentDefinition {
  id: string;
  name?: string;
  goal?: string;
  instructions?: string;
  /** Names of tools this agent may call, resolved against the registry at build time. */
  tools: string[];
  maxSteps?: number;
  temperature?: number;
  createdAt: string;
}

export interface AgentRepository {
  /**
   * Inserts a definition only if the id is free, returning false otherwise.
   *
   * This exists instead of a caller-side "does it exist?" check because that
   * check and the write are two steps: two concurrent requests for the same id
   * both pass it, and the second silently overwrites the first. Creation has
   * to be one atomic operation.
   */
  create(definition: AgentDefinition): Promise<boolean>;
  /** Inserts or overwrites. Use `create` when the id must be new. */
  save(definition: AgentDefinition): Promise<void>;
  get(id: string): Promise<AgentDefinition | null>;
  list(): Promise<AgentDefinition[]>;
  /** Returns false when the id was not present. */
  delete(id: string): Promise<boolean>;
}

export class InMemoryAgentRepository implements AgentRepository {
  readonly #definitions = new Map<string, AgentDefinition>();

  async create(definition: AgentDefinition): Promise<boolean> {
    // No await between the check and the write, so this is atomic on a single
    // event loop — which is all this implementation ever spans.
    if (this.#definitions.has(definition.id)) return false;
    this.#definitions.set(definition.id, { ...definition });
    return true;
  }

  async save(definition: AgentDefinition): Promise<void> {
    this.#definitions.set(definition.id, { ...definition });
  }

  async get(id: string): Promise<AgentDefinition | null> {
    const found = this.#definitions.get(id);
    return found ? { ...found } : null;
  }

  async list(): Promise<AgentDefinition[]> {
    return [...this.#definitions.values()].map((definition) => ({ ...definition }));
  }

  async delete(id: string): Promise<boolean> {
    return this.#definitions.delete(id);
  }
}
