export interface Document {
  id: string;
  text: string;
  metadata?: Record<string, unknown>;
}

export interface Chunk {
  id: string;
  documentId: string;
  text: string;
  index: number;
  metadata?: Record<string, unknown>;
}

export interface EmbeddedChunk extends Chunk {
  embedding: number[];
}

export interface SearchHit {
  chunk: Chunk;
  score: number;
}

export interface EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

export interface VectorStore {
  upsert(chunks: EmbeddedChunk[]): Promise<void>;
  search(embedding: number[], topK: number, filter?: Record<string, unknown>): Promise<SearchHit[]>;
  deleteByDocument(documentId: string): Promise<void>;
  count(): Promise<number>;
}
