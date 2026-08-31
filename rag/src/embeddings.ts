import type { EmbeddingProvider } from "./types.js";

/**
 * A deterministic hashing embedder (the "hashing trick").
 *
 * It needs no API key and no model download, which makes the RAG pipeline
 * testable offline. Quality is far below a trained model — swap in
 * `OpenAiEmbeddingProvider` for anything real.
 */
export class HashingEmbeddingProvider implements EmbeddingProvider {
  readonly name = "hashing";

  constructor(readonly dimensions = 256) {}

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.#embedOne(text));
  }

  #embedOne(text: string): number[] {
    const vector = new Array<number>(this.dimensions).fill(0);
    const tokens = text.toLowerCase().match(/[a-z0-9']+/g) ?? [];

    for (const token of tokens) {
      const bucket = fnv1a(token) % this.dimensions;
      // Signed buckets reduce collision bias between unrelated tokens.
      const sign = fnv1a(`${token}#sign`) % 2 === 0 ? 1 : -1;
      vector[bucket] = (vector[bucket] ?? 0) + sign;
    }

    return normalise(vector);
  }
}

export interface OpenAiEmbeddingOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  dimensions?: number;
}

export class OpenAiEmbeddingProvider implements EmbeddingProvider {
  readonly name = "openai";
  readonly dimensions: number;
  readonly #apiKey: string;
  readonly #model: string;
  readonly #baseUrl: string;

  constructor(options: OpenAiEmbeddingOptions) {
    if (!options.apiKey) throw new Error("OpenAiEmbeddingProvider requires an apiKey");
    this.#apiKey = options.apiKey;
    this.#model = options.model ?? "text-embedding-3-small";
    this.#baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
    this.dimensions = options.dimensions ?? 1_536;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const response = await fetch(`${this.#baseUrl}/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.#apiKey}` },
      body: JSON.stringify({ model: this.#model, input: texts }),
    });

    if (!response.ok) {
      throw new Error(`Embedding request failed (${response.status}): ${await response.text()}`);
    }

    const payload = (await response.json()) as { data: { index: number; embedding: number[] }[] };
    return payload.data.sort((a, b) => a.index - b.index).map((item) => item.embedding);
  }
}

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

function normalise(vector: number[]): number[] {
  const magnitude = Math.hypot(...vector);
  return magnitude === 0 ? vector : vector.map((value) => value / magnitude);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error(`Vector length mismatch: ${a.length} vs ${b.length}`);

  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    magA += x * x;
    magB += y * y;
  }

  const denominator = Math.sqrt(magA) * Math.sqrt(magB);
  return denominator === 0 ? 0 : dot / denominator;
}
