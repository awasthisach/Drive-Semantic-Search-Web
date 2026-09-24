/** Model-agnostic embedding contract — Gemini is one implementation, not the API surface. */

export interface EmbeddingMeta {
  embeddingModel: string;
  embeddingVersion: string;
  dimension: number;
}

export interface EmbeddingProvider extends EmbeddingMeta {
  /** Batch embed for document/chunk bodies (retrieval documents). */
  embedDocuments(texts: string[]): Promise<number[][]>;
  /** Single query vector for search. */
  embedQuery(text: string): Promise<number[]>;
}

export type EmbedInputMode = 'document' | 'query';

export interface EmbedRequest {
  texts: string[];
  mode: EmbedInputMode;
  /** Allows the Worker to serve legacy and current clients during rollout. */
  version?: string;
}

export interface EmbedResponse {
  embeddings: number[][];
  model: string;
  version: string;
  dimension: number;
}

/** Chunk row that will hold a vector once Phase 3b/4 is wired. */
export interface IndexedChunkVector {
  id: string;
  fileId: string;
  idx: number;
  text: string;
  /** Dense vector; prefer Float32Array when writing to IDB. */
  embedding: number[];
  corpusKey?: string;
  contentHash?: string;
  embeddingModel: string;
  embeddingVersion: string;
  dimension: number;
  driveModifiedTime?: string;
}
