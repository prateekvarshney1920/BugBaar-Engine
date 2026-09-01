import type { Tool } from "@bugbaar/tools";
import type { RagPipeline } from "./pipeline.js";

export interface KnowledgeSearchToolOptions {
  /** The pipeline to search. Embedding and storage stay its concern, not ours. */
  pipeline: RagPipeline;
  /** Chunks returned when the model does not ask for a specific number. */
  defaultTopK?: number;
  /** Upper bound on `topK`, so a model cannot pull the whole index into a prompt. */
  maxTopK?: number;
}

export interface KnowledgeSearchSource {
  documentId: string;
  chunkId: string;
  score: number;
}

export interface KnowledgeSearchResult {
  query: string;
  /** Number of chunks that cleared the pipeline's score threshold. */
  matches: number;
  /**
   * The retrieved text, already wrapped in the pipeline's untrusted-data
   * boundary. Empty when nothing matched.
   */
  context: string;
  sources: KnowledgeSearchSource[];
}

/**
 * Knowledge-base retrieval, exposed as an ordinary agent tool.
 *
 * This is what makes retrieval an agent *decision* rather than a caller's.
 * `POST /v1/knowledge/ask` already retrieves and hands the result to an agent,
 * but that requires the caller to know in advance that retrieval is wanted. As
 * a tool, the model itself chooses when its own knowledge is insufficient —
 * and the choice, its arguments, and its outcome land in the run trace like
 * any other tool call.
 *
 * It is deliberately thin. Chunking, embedding, vector search, score
 * thresholds, and the injection boundary all remain in `RagPipeline`; a second
 * retrieval path would be free to drift away from the first.
 */
export function createKnowledgeSearchTool(
  options: KnowledgeSearchToolOptions,
): Tool<{ query: string; topK?: number }, KnowledgeSearchResult> {
  const { pipeline } = options;
  const defaultTopK = options.defaultTopK ?? 5;
  const maxTopK = options.maxTopK ?? 20;

  return {
    name: "knowledge_search",
    description:
      "Search the knowledge base for passages relevant to a question, and return them with their source " +
      "document ids and similarity scores. Use it whenever a question may depend on ingested documents " +
      "rather than general knowledge. A result with matches=0 means nothing relevant is indexed — say so " +
      "instead of guessing.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Natural-language description of the information needed.",
        },
        topK: {
          type: "integer",
          description: `Maximum passages to return (1-${maxTopK}, default ${defaultTopK}).`,
        },
      },
      required: ["query"],
      additionalProperties: false,
    },

    async execute({ query, topK }) {
      const trimmed = query.trim();
      // The registry turns this into a tool failure the model can read and
      // retry against, which is more useful than an empty search.
      if (!trimmed) throw new Error("query must not be empty");

      // The shared validator checks types, not ranges, so the bound is applied
      // here. Clamping rather than rejecting: an out-of-range topK is a
      // recoverable mistake, and failing the call would cost the agent a step.
      const requested = topK ?? defaultTopK;
      const limit = Math.min(Math.max(Math.trunc(requested), 1), maxTopK);

      // buildContext, not retrieve: it applies the untrusted-data boundary
      // that keeps retrieved text from reading as instructions.
      const { context, hits } = await pipeline.buildContext(trimmed, { topK: limit });

      return {
        query: trimmed,
        matches: hits.length,
        context,
        sources: hits.map((hit) => ({
          documentId: hit.chunk.documentId,
          chunkId: hit.chunk.id,
          score: Number(hit.score.toFixed(4)),
        })),
      };
    },
  };
}
