import type { Chunk, Document } from "./types.js";

export interface ChunkOptions {
  /** Target chunk size in characters. */
  size?: number;
  /** Characters repeated from the previous chunk to preserve context. */
  overlap?: number;
}

/**
 * Splits a document into overlapping chunks, preferring to break at paragraph
 * or sentence boundaries so a chunk rarely ends mid-thought.
 */
export function chunkDocument(document: Document, options: ChunkOptions = {}): Chunk[] {
  const size = options.size ?? 1_000;
  const overlap = options.overlap ?? 150;

  if (size <= 0) throw new Error("Chunk size must be positive");
  if (overlap >= size) throw new Error("Chunk overlap must be smaller than chunk size");

  const text = document.text.trim();
  if (text.length === 0) return [];
  if (text.length <= size) {
    return [{ id: `${document.id}:0`, documentId: document.id, text, index: 0, metadata: document.metadata }];
  }

  const chunks: Chunk[] = [];
  let cursor = 0;
  let index = 0;

  while (cursor < text.length) {
    const hardEnd = Math.min(cursor + size, text.length);
    const end = hardEnd === text.length ? hardEnd : findBoundary(text, cursor, hardEnd);
    const slice = text.slice(cursor, end).trim();

    if (slice.length > 0) {
      chunks.push({
        id: `${document.id}:${index}`,
        documentId: document.id,
        text: slice,
        index,
        metadata: document.metadata,
      });
      index += 1;
    }

    if (end >= text.length) break;
    cursor = Math.max(end - overlap, cursor + 1);
  }

  return chunks;
}

/** Walks back from `hardEnd` looking for a paragraph, sentence, or word break. */
function findBoundary(text: string, start: number, hardEnd: number): number {
  const window = text.slice(start, hardEnd);
  const minimum = Math.floor(window.length * 0.5);

  for (const separator of ["\n\n", ". ", "\n", " "]) {
    const found = window.lastIndexOf(separator);
    if (found > minimum) return start + found + separator.length;
  }
  return hardEnd;
}
