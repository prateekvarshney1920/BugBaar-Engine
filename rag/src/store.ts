import { cosineSimilarity } from "./embeddings.js";
import type { EmbeddedChunk, SearchHit, VectorStore } from "./types.js";

/** Brute-force cosine search. Fine up to a few thousand chunks; use Qdrant beyond that. */
export class InMemoryVectorStore implements VectorStore {
  readonly #chunks = new Map<string, EmbeddedChunk>();

  async upsert(chunks: EmbeddedChunk[]): Promise<void> {
    for (const chunk of chunks) this.#chunks.set(chunk.id, chunk);
  }

  async search(embedding: number[], topK: number, filter?: Record<string, unknown>): Promise<SearchHit[]> {
    const hits: SearchHit[] = [];

    for (const chunk of this.#chunks.values()) {
      if (filter && !matchesFilter(chunk.metadata, filter)) continue;
      const { embedding: _embedding, ...rest } = chunk;
      hits.push({ chunk: rest, score: cosineSimilarity(embedding, chunk.embedding) });
    }

    return hits.sort((a, b) => b.score - a.score).slice(0, topK);
  }

  async deleteByDocument(documentId: string): Promise<void> {
    for (const [id, chunk] of this.#chunks) {
      if (chunk.documentId === documentId) this.#chunks.delete(id);
    }
  }

  async count(): Promise<number> {
    return this.#chunks.size;
  }
}

export interface QdrantStoreOptions {
  url: string;
  collection: string;
  apiKey?: string;
  dimensions: number;
}

/**
 * Qdrant-backed vector store over the REST API.
 *
 * Chunk ids are hashed to UUIDs because Qdrant point ids must be an unsigned
 * integer or a UUID, while our chunk ids are readable strings.
 */
export class QdrantVectorStore implements VectorStore {
  readonly #url: string;
  readonly #collection: string;
  readonly #apiKey?: string;
  readonly #dimensions: number;

  constructor(options: QdrantStoreOptions) {
    this.#url = options.url.replace(/\/$/, "");
    this.#collection = options.collection;
    this.#apiKey = options.apiKey;
    this.#dimensions = options.dimensions;
  }

  /** Creates the collection if it does not already exist. Safe to call on boot. */
  async ensureCollection(): Promise<void> {
    const existing = await fetch(`${this.#url}/collections/${this.#collection}`, { headers: this.#headers() });
    if (existing.ok) return;

    const created = await fetch(`${this.#url}/collections/${this.#collection}`, {
      method: "PUT",
      headers: this.#headers(),
      body: JSON.stringify({ vectors: { size: this.#dimensions, distance: "Cosine" } }),
    });
    if (!created.ok) {
      throw new Error(`Failed to create Qdrant collection (${created.status}): ${await created.text()}`);
    }
  }

  async upsert(chunks: EmbeddedChunk[]): Promise<void> {
    if (chunks.length === 0) return;

    await this.#request(`/collections/${this.#collection}/points?wait=true`, "PUT", {
      points: chunks.map(({ embedding, ...chunk }) => ({
        id: toUuid(chunk.id),
        vector: embedding,
        payload: chunk,
      })),
    });
  }

  async search(embedding: number[], topK: number, filter?: Record<string, unknown>): Promise<SearchHit[]> {
    const body = await this.#request<{ result: { score: number; payload: SearchHit["chunk"] }[] }>(
      `/collections/${this.#collection}/points/search`,
      "POST",
      {
        vector: embedding,
        limit: topK,
        with_payload: true,
        // Chunk metadata is stored nested under `metadata`, so filter keys need
        // that prefix. Without it Qdrant matches a top-level field that does
        // not exist and silently returns nothing — while InMemoryVectorStore,
        // which reads chunk.metadata directly, returns the right answer. Two
        // implementations of one interface must not disagree.
        ...(filter
          ? {
              filter: {
                must: Object.entries(filter).map(([key, value]) => ({ key: `metadata.${key}`, match: { value } })),
              },
            }
          : {}),
      },
    );

    return body.result.map((hit) => ({ chunk: hit.payload, score: hit.score }));
  }

  async deleteByDocument(documentId: string): Promise<void> {
    await this.#request(`/collections/${this.#collection}/points/delete?wait=true`, "POST", {
      filter: { must: [{ key: "documentId", match: { value: documentId } }] },
    });
  }

  async count(): Promise<number> {
    const body = await this.#request<{ result: { count: number } }>(
      `/collections/${this.#collection}/points/count`,
      "POST",
      { exact: true },
    );
    return body.result.count;
  }

  #headers(): Record<string, string> {
    return { "content-type": "application/json", ...(this.#apiKey ? { "api-key": this.#apiKey } : {}) };
  }

  async #request<T = unknown>(path: string, method: string, body: unknown): Promise<T> {
    const response = await fetch(`${this.#url}${path}`, {
      method,
      headers: this.#headers(),
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`Qdrant ${method} ${path} failed (${response.status}): ${await response.text()}`);
    }
    return (await response.json()) as T;
  }
}

function matchesFilter(metadata: Record<string, unknown> | undefined, filter: Record<string, unknown>): boolean {
  if (!metadata) return false;
  return Object.entries(filter).every(([key, value]) => metadata[key] === value);
}

/** Deterministic UUIDv4-shaped id derived from an arbitrary string. */
function toUuid(value: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < value.length; i += 1) {
    h1 = Math.imul(h1 ^ value.charCodeAt(i), 0x01000193) >>> 0;
    h2 = Math.imul(h2 + value.charCodeAt(i), 0x85ebca6b) >>> 0;
  }
  const hex = (h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0")).repeat(2);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `a${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}
