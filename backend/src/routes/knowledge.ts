import {
  asObject,
  optionalNumber,
  requireArray,
  requireString,
  RequestValidationError,
  type IngestResponse,
  type SearchResponse,
} from "@bugbaar/api";
import type { Document } from "@bugbaar/rag";
import { Router } from "express";
import { asyncHandler, pathParam } from "../middleware/index.js";
import type { Container } from "../services/container.js";

export function knowledgeRoutes(container: Container): Router {
  const router = Router();

  router.post(
    "/knowledge/documents",
    asyncHandler(async (req, res) => {
      const body = asObject(req.body);
      const raw = requireArray(body, "documents", 200);

      const documents: Document[] = raw.map((item, index) => {
        const entry = asObject(item, `documents[${index}]`);
        return {
          id: requireString(entry, "id", { maxLength: 200 }),
          text: requireString(entry, "text", { maxLength: 1_000_000 }),
          metadata:
            entry.metadata === undefined ? undefined : asObject(entry.metadata, `documents[${index}].metadata`),
        };
      });

      const result = await container.rag.ingest(documents);
      req.log.info("documents ingested", result);
      await container.events.emit("knowledge.ingested", result);

      const response: IngestResponse = result;
      res.status(201).json(response);
    }),
  );

  router.post(
    "/knowledge/search",
    asyncHandler(async (req, res) => {
      const body = asObject(req.body);
      const query = requireString(body, "query", { maxLength: 4_000 });
      const topK = optionalNumber(body, "topK", { min: 1, max: 50 }) ?? 5;
      const filter = body.filter === undefined ? undefined : asObject(body.filter, "filter");

      const hits = await container.rag.retrieve(query, { topK, filter });

      const response: SearchResponse = {
        query,
        hits: hits.map((hit) => ({
          documentId: hit.chunk.documentId,
          chunkId: hit.chunk.id,
          text: hit.chunk.text,
          score: Number(hit.score.toFixed(4)),
        })),
      };
      res.json(response);
    }),
  );

  /**
   * Retrieval-augmented answering: build context, then ask an agent.
   *
   * The retrieved text is passed as clearly-delimited reference data and the
   * agent is instructed not to follow directives inside it.
   */
  router.post(
    "/knowledge/ask",
    asyncHandler(async (req, res) => {
      const body = asObject(req.body);
      const query = requireString(body, "query", { maxLength: 4_000 });
      const agentId = requireString(body, "agentId", { maxLength: 64 });
      const topK = optionalNumber(body, "topK", { min: 1, max: 20 }) ?? 5;

      const agent = container.agents.get(agentId);
      if (!agent) throw new RequestValidationError(`Agent "${agentId}" does not exist`);

      const { context, hits } = await container.rag.buildContext(query, { topK });
      const prompt = context
        ? `${context}\n\nUsing only the reference documents above, answer the question.\nQuestion: ${query}`
        : `No reference documents matched. Answer from general knowledge and say so.\nQuestion: ${query}`;

      const result = await agent.run(prompt, { sessionId: `rag:${agentId}` });

      res.json({
        answer: result.output,
        runId: result.runId,
        sources: hits.map((hit) => ({ documentId: hit.chunk.documentId, score: Number(hit.score.toFixed(4)) })),
      });
    }),
  );

  router.delete(
    "/knowledge/documents/:id",
    asyncHandler(async (req, res) => {
      const documentId = pathParam(req, "id");
      await container.rag.remove(documentId);
      req.log.info("document removed", { documentId });
      res.status(204).end();
    }),
  );

  router.get(
    "/knowledge/stats",
    asyncHandler(async (_req, res) => {
      res.json(await container.rag.stats());
    }),
  );

  return router;
}
