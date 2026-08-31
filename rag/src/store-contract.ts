import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { HashingEmbeddingProvider } from "./embeddings.js";
import type { EmbeddedChunk, VectorStore } from "./types.js";

/**
 * The behaviour every VectorStore must exhibit, regardless of backend.
 *
 * This exists because `InMemoryVectorStore` and `QdrantVectorStore` once
 * disagreed about metadata filtering: the in-memory store read
 * `chunk.metadata[key]` while the Qdrant store queried a top-level payload
 * field, so the same filter returned a hit locally and nothing in production.
 * Testing each store separately never surfaced it. Running one suite against
 * both does.
 *
 * Any new backend — pgvector, Pinecone, Weaviate — should be added here first.
 */

export const CONTRACT_DIMENSIONS = 64;

export interface ContractOptions {
  /** Builds an empty store. Called once per test so cases stay isolated. */
  createStore: (testName: string) => Promise<VectorStore>;
  /** Skip reason when the backend is unavailable, or false to run. */
  skip?: string | false;
}

export function runVectorStoreContract(backendName: string, options: ContractOptions): void {
  const embeddings = new HashingEmbeddingProvider(CONTRACT_DIMENSIONS);
  const skip = (): { skip: string | boolean } => ({ skip: options.skip ?? false });

  const vector = async (text: string): Promise<number[]> => {
    const [embedding] = await embeddings.embed([text]);
    return embedding!;
  };

  const chunk = async (
    id: string,
    documentId: string,
    text: string,
    metadata?: Record<string, unknown>,
  ): Promise<EmbeddedChunk> => ({
    id,
    documentId,
    text,
    index: 0,
    ...(metadata ? { metadata } : {}),
    embedding: await vector(text),
  });

  describe(`VectorStore contract: ${backendName}`, () => {
    test("stores a chunk and finds it by similarity", skip(), async () => {
      const store = await options.createStore("similarity");
      await store.upsert([await chunk("v:0", "vectors", "Qdrant stores vector embeddings for semantic search.")]);

      const hits = await store.search(await vector("vector embeddings semantic search"), 5);

      assert.equal(hits.length, 1);
      assert.equal(hits[0]?.chunk.id, "v:0");
      assert.equal(hits[0]?.chunk.documentId, "vectors");
      assert.match(hits[0]?.chunk.text ?? "", /Qdrant stores/);
      assert.ok((hits[0]?.score ?? 0) > 0.5, "an on-topic query should score highly");
    });

    test("ranks a closer match above a weaker one", skip(), async () => {
      const store = await options.createStore("ranking");
      await store.upsert([
        await chunk("a:0", "a", "vector embeddings semantic search over documents"),
        await chunk("b:0", "b", "completely unrelated text about gardening tools"),
      ]);

      const hits = await store.search(await vector("vector embeddings semantic search"), 2);

      assert.equal(hits.length, 2);
      assert.equal(hits[0]?.chunk.documentId, "a");
      assert.ok((hits[0]?.score ?? 0) > (hits[1]?.score ?? 0), "hits must be ordered by descending score");
    });

    test("upserting the same id replaces rather than duplicates", skip(), async () => {
      const store = await options.createStore("replace");
      await store.upsert([await chunk("doc:0", "doc", "original text")]);
      await store.upsert([await chunk("doc:0", "doc", "replacement text")]);

      assert.equal(await store.count(), 1);
      const hits = await store.search(await vector("replacement"), 1);
      assert.equal(hits[0]?.chunk.text, "replacement text");
    });

    test("topK bounds the number of hits", skip(), async () => {
      const store = await options.createStore("topk");
      await store.upsert([
        await chunk("m:0", "many", "one"),
        await chunk("m:1", "many", "two"),
        await chunk("m:2", "many", "three"),
      ]);

      assert.equal((await store.search(await vector("one"), 2)).length, 2);
      assert.equal((await store.search(await vector("one"), 10)).length, 3);
    });

    // The case that caught the production bug.
    test("metadata filters restrict results to matching chunks", skip(), async () => {
      const store = await options.createStore("filter");
      await store.upsert([
        await chunk("a:0", "a", "platform runbook", { team: "platform" }),
        await chunk("b:0", "b", "finance policy", { team: "finance" }),
      ]);

      const query = await vector("policy runbook");

      assert.equal((await store.search(query, 10)).length, 2);

      const filtered = await store.search(query, 10, { team: "finance" });
      assert.equal(filtered.length, 1, "a filter that matches one chunk must return exactly that chunk");
      assert.equal(filtered[0]?.chunk.documentId, "b");
    });

    test("a filter matching nothing returns nothing", skip(), async () => {
      const store = await options.createStore("filter-miss");
      await store.upsert([await chunk("a:0", "a", "platform runbook", { team: "platform" })]);

      assert.deepEqual(await store.search(await vector("runbook"), 10, { team: "nobody" }), []);
    });

    test("deleteByDocument removes only that document's chunks", skip(), async () => {
      const store = await options.createStore("delete");
      await store.upsert([
        await chunk("k:0", "keeper", "keep one"),
        await chunk("k:1", "keeper", "keep two"),
        await chunk("d:0", "doomed", "remove me"),
      ]);
      assert.equal(await store.count(), 3);

      await store.deleteByDocument("doomed");

      assert.equal(await store.count(), 2);
      const hits = await store.search(await vector("keep"), 10);
      assert.equal(
        hits.every((hit) => hit.chunk.documentId === "keeper"),
        true,
      );
    });

    test("deleting an unknown document is a no-op, not an error", skip(), async () => {
      const store = await options.createStore("delete-miss");
      await store.upsert([await chunk("a:0", "a", "still here")]);

      await store.deleteByDocument("never-existed");
      assert.equal(await store.count(), 1);
    });

    test("searching an empty store returns nothing rather than throwing", skip(), async () => {
      const store = await options.createStore("empty");
      assert.deepEqual(await store.search(await vector("anything"), 5), []);
      assert.equal(await store.count(), 0);
    });

    test("upserting an empty batch is a no-op", skip(), async () => {
      const store = await options.createStore("noop");
      await store.upsert([]);
      assert.equal(await store.count(), 0);
    });

    test("search results never leak the raw embedding", skip(), async () => {
      const store = await options.createStore("no-embedding");
      await store.upsert([await chunk("a:0", "a", "some text")]);

      const [hit] = await store.search(await vector("some text"), 1);

      // Vectors are large and useless to callers; returning them would bloat
      // every API response that surfaces a hit.
      assert.equal("embedding" in (hit?.chunk ?? {}), false);
    });
  });
}
