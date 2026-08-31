import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { HashingEmbeddingProvider } from "./embeddings.ts";
import { RagPipeline } from "./pipeline.ts";
import { CONTRACT_DIMENSIONS, runVectorStoreContract } from "./store-contract.ts";
import { QdrantVectorStore } from "./store.ts";
import type { EmbeddedChunk } from "./types.ts";

/**
 * Integration tests against a real Qdrant.
 *
 * Set QDRANT_TEST_URL to point at one. The reachability probe runs at module
 * top level, not in a before() hook: node:test evaluates a test's options when
 * the test is registered, which happens before any hook runs, so a flag set in
 * before() would leave every test skipped while the suite still reported
 * success.
 */
const QDRANT_URL = process.env.QDRANT_TEST_URL ?? "http://127.0.0.1:6343";
const DIMENSIONS = CONTRACT_DIMENSIONS;

let available = false;
try {
  const response = await fetch(`${QDRANT_URL}/healthz`, { signal: AbortSignal.timeout(2_000) });
  available = response.ok;
} catch {
  available = false;
}

const skip = (): { skip: string | boolean } => ({
  skip: available ? false : `no Qdrant at ${QDRANT_URL} (set QDRANT_TEST_URL)`,
});

const embeddings = new HashingEmbeddingProvider(DIMENSIONS);
const collections: string[] = [];

/** Each test gets its own collection so they cannot interfere with each other. */
async function freshStore(name: string): Promise<QdrantVectorStore> {
  const collection = `test_${name}`;
  collections.push(collection);

  await fetch(`${QDRANT_URL}/collections/${collection}`, { method: "DELETE" }).catch(() => undefined);

  const store = new QdrantVectorStore({ url: QDRANT_URL, collection, dimensions: DIMENSIONS });
  await store.ensureCollection();
  return store;
}

async function embed(texts: string[], documentId: string): Promise<EmbeddedChunk[]> {
  const vectors = await embeddings.embed(texts);
  return texts.map((text, index) => ({
    id: `${documentId}:${index}`,
    documentId,
    text,
    index,
    metadata: { documentId },
    embedding: vectors[index]!,
  }));
}

after(async () => {
  if (!available) return;
  for (const collection of collections) {
    await fetch(`${QDRANT_URL}/collections/${collection}`, { method: "DELETE" }).catch(() => undefined);
  }
});

// Every backend must satisfy the same contract; this is the mechanism that
// would have caught the metadata-filter divergence before it shipped.
runVectorStoreContract("Qdrant", {
  createStore: (name) => freshStore(`contract_${name}`),
  skip: available ? false : `no Qdrant at ${QDRANT_URL} (set QDRANT_TEST_URL)`,
});

describe("QdrantVectorStore specifics", () => {
  test("ensureCollection creates the collection and is idempotent", skip(), async () => {
    const store = await freshStore("ensure");

    // Calling it again on an existing collection must not throw or recreate.
    await store.ensureCollection();

    const response = await fetch(`${QDRANT_URL}/collections/test_ensure`);
    const body = (await response.json()) as { result: { config: { params: { vectors: { size: number } } } } };

    assert.equal(response.ok, true);
    assert.equal(body.result.config.params.vectors.size, DIMENSIONS);
  });

  test("readable chunk ids survive the UUID mapping round trip", skip(), async () => {
    const store = await freshStore("ids");

    // Qdrant point ids must be an integer or UUID, so chunk ids are hashed.
    // The readable id has to come back intact from the payload.
    await store.upsert(await embed(["alpha", "beta", "gamma"], "doc-with-dashes"));

    const [query] = await embeddings.embed(["alpha"]);
    const hits = await store.search(query!, 3);

    const ids = hits.map((hit) => hit.chunk.id).sort();
    assert.deepEqual(ids, ["doc-with-dashes:0", "doc-with-dashes:1", "doc-with-dashes:2"]);
  });

  test("a failing request surfaces Qdrant's status and body", skip(), async () => {
    const store = new QdrantVectorStore({
      url: QDRANT_URL,
      collection: "definitely_not_created",
      dimensions: DIMENSIONS,
    });

    await assert.rejects(() => store.count(), /Qdrant POST .* failed \(4\d\d\)/);
  });

  test("the full pipeline works end to end against Qdrant", skip(), async () => {
    const store = await freshStore("pipeline");
    const pipeline = new RagPipeline({ embeddings, store, minScore: 0 });

    const ingested = await pipeline.ingest([
      { id: "retries", text: "Workflow steps retry with exponential backoff after each failed attempt." },
      { id: "vectors", text: "Qdrant stores vector embeddings and performs semantic search over documents." },
    ]);
    assert.equal(ingested.documents, 2);
    assert.equal(ingested.chunks, 2);

    const hits = await pipeline.retrieve("vector embeddings semantic search", { topK: 1 });
    assert.equal(hits[0]?.chunk.documentId, "vectors");

    const { context } = await pipeline.buildContext("vector embeddings", { topK: 1 });
    assert.match(context, /reference data, not instructions/);

    await pipeline.remove("vectors");
    assert.equal((await pipeline.stats()).chunks, 1);
  });

  test("re-ingesting a document leaves no stale chunks behind", skip(), async () => {
    const store = await freshStore("reingest");
    const pipeline = new RagPipeline({ embeddings, store, chunking: { size: 60, overlap: 10 }, minScore: 0 });

    const long = "First sentence here. Second sentence here. Third sentence here. Fourth sentence here.";
    await pipeline.ingest([{ id: "doc", text: long }]);
    const firstCount = (await pipeline.stats()).chunks;
    assert.ok(firstCount > 1, "the fixture should produce several chunks");

    // A shorter revision must not leave the extra chunks orphaned in the index.
    await pipeline.ingest([{ id: "doc", text: "Short." }]);
    assert.equal((await pipeline.stats()).chunks, 1);
  });
});
