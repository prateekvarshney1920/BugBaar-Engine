import type { Message } from "./types.js";

/**
 * Conversation memory for a single agent.
 *
 * Implementations are swappable: `InMemoryStore` for tests and local dev, a
 * MongoDB-backed store for production. The interface stays deliberately narrow
 * so a persistence layer only has to implement four methods.
 */
export interface MemoryStore {
  append(sessionId: string, messages: Message[]): Promise<void>;
  history(sessionId: string, limit?: number): Promise<Message[]>;
  clear(sessionId: string): Promise<void>;
  sessions(): Promise<string[]>;
}

export class InMemoryStore implements MemoryStore {
  readonly #sessions = new Map<string, Message[]>();

  constructor(private readonly maxMessagesPerSession = 200) {}

  async append(sessionId: string, messages: Message[]): Promise<void> {
    const existing = this.#sessions.get(sessionId) ?? [];
    const stamped = messages.map((message) => ({
      ...message,
      createdAt: message.createdAt ?? new Date().toISOString(),
    }));
    const next = [...existing, ...stamped];
    // Keep the tail; the oldest turns are the cheapest context to drop.
    this.#sessions.set(sessionId, next.slice(-this.maxMessagesPerSession));
  }

  async history(sessionId: string, limit?: number): Promise<Message[]> {
    const messages = this.#sessions.get(sessionId) ?? [];
    return limit === undefined ? [...messages] : messages.slice(-limit);
  }

  async clear(sessionId: string): Promise<void> {
    this.#sessions.delete(sessionId);
  }

  async sessions(): Promise<string[]> {
    return [...this.#sessions.keys()];
  }
}
