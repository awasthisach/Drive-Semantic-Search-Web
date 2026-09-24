/**
 * Phase 3b — IndexedDB vector store (independent of BM25 postings).
 * Phase 4 — cosine ranking helpers.
 * Same contentHash + model + version + dimension → skip re-embed.
 * API failure must not delete existing valid vectors.
 */
import type { EmbeddingProvider } from './embeddings/types';
import { EMBED_CONFIG } from './embeddings/config';
import { cosineSimilarity } from './embeddings/vector';

const DB_NAME = 'drive-vector-index';
const DB_VERSION = 1;
const VECTOR_STORE = 'vectors';

export interface VectorRecord {
  id: string;
  fileId: string;
  idx: number;
  text: string;
  embedding: number[];
  corpusKey: string;
  contentHash: string;
  embeddingModel: string;
  embeddingVersion: string;
  dimension: number;
  driveModifiedTime?: string;
  indexedAt: string;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB not available'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error || new Error('vector index open failed'));
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(VECTOR_STORE)) {
        const store = db.createObjectStore(VECTOR_STORE, { keyPath: 'id' });
        store.createIndex('fileId', 'fileId', { unique: false });
        store.createIndex('corpusKey', 'corpusKey', { unique: false });
        store.createIndex('contentHash', 'contentHash', { unique: false });
      }
    };
  });
}

export async function hashContent(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export function isCompatibleVector(
  rec: VectorRecord,
  contentHash: string,
  model: string,
  version: string,
  dimension: number
): boolean {
  return (
    rec.contentHash === contentHash &&
    rec.embeddingModel === model &&
    rec.embeddingVersion === version &&
    rec.dimension === dimension &&
    Array.isArray(rec.embedding) &&
    rec.embedding.length === dimension
  );
}

export async function hasCompatibleVectorSet(opts: {
  fileId: string;
  corpusKey: string;
  chunks: string[];
  embeddingModel?: string;
  embeddingVersion?: string;
  dimension?: number;
}): Promise<boolean> {
  const model = opts.embeddingModel ?? EMBED_CONFIG.model;
  const version = opts.embeddingVersion ?? EMBED_CONFIG.version;
  const dimension = opts.dimension ?? EMBED_CONFIG.dimension;
  const vectors = await getVectorsForFile(opts.fileId, opts.corpusKey);
  const byIdx = new Map(vectors.map(v => [v.idx, v]));
  const nonEmpty = opts.chunks.filter(chunk => Boolean(chunk && chunk.trim()));
  if (vectors.length !== nonEmpty.length) return false;
  for (let idx = 0; idx < opts.chunks.length; idx++) {
    const text = opts.chunks[idx];
    if (!text || !text.trim()) continue;
    const hash = await hashContent(text);
    const rec = byIdx.get(idx);
    if (!rec || !isCompatibleVector(rec, hash, model, version, dimension)) return false;
  }
  return true;
}

export async function getVectorsForFile(fileId: string, corpusKey?: string): Promise<VectorRecord[]> {
  try {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const req = db
        .transaction(VECTOR_STORE, 'readonly')
        .objectStore(VECTOR_STORE)
        .index('fileId')
        .getAll(fileId);
      req.onsuccess = () => {
        const rows = (req.result || []) as VectorRecord[];
        resolve(corpusKey ? rows.filter(v => v.corpusKey === corpusKey) : rows);
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

export async function listVectors(corpusKey?: string): Promise<VectorRecord[]> {
  try {
    const db = await openDb();
    const all: VectorRecord[] = await new Promise((resolve, reject) => {
      const req = db.transaction(VECTOR_STORE, 'readonly').objectStore(VECTOR_STORE).getAll();
      req.onsuccess = () => resolve((req.result || []) as VectorRecord[]);
      req.onerror = () => reject(req.error);
    });
    if (!corpusKey) return all;
    return all.filter(v => v.corpusKey === corpusKey);
  } catch {
    return [];
  }
}

export async function countVectors(corpusKey?: string): Promise<number> {
  return (await listVectors(corpusKey)).length;
}

export async function removeVectorsForFile(
  fileId: string,
  corpusKey?: string
): Promise<number> {
  try {
    const existing = await getVectorsForFile(fileId, corpusKey);
    if (!existing.length) return 0;
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(VECTOR_STORE, 'readwrite');
      for (const v of existing) tx.objectStore(VECTOR_STORE).delete(v.id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    return existing.length;
  } catch (e) {
    console.warn('[vectorIndex] remove failed', fileId, e);
    return 0;
  }
}

export async function embedAndStoreChunks(opts: {
  provider: EmbeddingProvider;
  fileId: string;
  chunks: string[];
  corpusKey: string;
  driveModifiedTime?: string;
}): Promise<{ stored: number; skipped: number; failed: boolean }> {
  const { provider, fileId, chunks, corpusKey, driveModifiedTime } = opts;
  const model = provider.embeddingModel;
  const version = provider.embeddingVersion;
  const dimension = provider.dimension;

  if (dimension !== EMBED_CONFIG.dimension) {
    throw new Error(`Vector dimension ${dimension} != configured ${EMBED_CONFIG.dimension}`);
  }

  const existing = await getVectorsForFile(fileId, corpusKey);
  const byIdx = new Map(existing.map(v => [v.idx, v]));

  const toEmbed: { idx: number; text: string; contentHash: string }[] = [];
  let skipped = 0;

  for (let idx = 0; idx < chunks.length; idx++) {
    const text = chunks[idx];
    if (!text || !text.trim()) continue;
    const contentHash = await hashContent(text);
    const prev = byIdx.get(idx);
    if (prev && isCompatibleVector(prev, contentHash, model, version, dimension)) {
      skipped++;
      continue;
    }
    toEmbed.push({ idx, text, contentHash });
  }

  if (!toEmbed.length) {
    return { stored: 0, skipped, failed: false };
  }

  const batchSize = EMBED_CONFIG.maxTextsPerBatch;
  const newRecords: VectorRecord[] = [];
  try {
    for (let i = 0; i < toEmbed.length; i += batchSize) {
      const batch = toEmbed.slice(i, i + batchSize);
      const vectors = await provider.embedDocuments(batch.map(b => b.text));
      if (vectors.length !== batch.length) {
        throw new Error('embed batch length mismatch');
      }
      const now = new Date().toISOString();
      for (let j = 0; j < batch.length; j++) {
        const emb = vectors[j];
        if (!emb || emb.length !== dimension) {
          throw new Error('embed dimension mismatch');
        }
        const b = batch[j];
        newRecords.push({
          id: corpusKey + '::' + fileId + '#' + b.idx,
          fileId,
          idx: b.idx,
          text: b.text.slice(0, 2000),
          embedding: emb,
          corpusKey,
          contentHash: b.contentHash,
          embeddingModel: model,
          embeddingVersion: version,
          dimension,
          driveModifiedTime,
          indexedAt: now,
        });
      }
    }
  } catch (e) {
    console.warn('[vectorIndex] embed failed; keeping prior vectors', fileId, e);
    return { stored: 0, skipped, failed: true };
  }

  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(VECTOR_STORE, 'readwrite');
      for (const rec of newRecords) {
        tx.objectStore(VECTOR_STORE).put(rec);
      }
      for (const prev of existing) {
        if (!newRecords.some(rec => rec.id === prev.id)) {
          tx.objectStore(VECTOR_STORE).delete(prev.id);
        }
      }
      const maxIdx = chunks.length;
      for (const prev of existing) {
        if (prev.idx >= maxIdx) {
          tx.objectStore(VECTOR_STORE).delete(prev.id);
        }
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    return { stored: newRecords.length, skipped, failed: false };
  } catch (e) {
    console.warn('[vectorIndex] store failed', fileId, e);
    return { stored: 0, skipped, failed: true };
  }
}

export async function pruneMissingVectors(opts: {
  liveFileIds: Set<string>;
  corpusKey?: string;
  complete: boolean;
}): Promise<number> {
  if (!opts.complete) return 0;
  const all = await listVectors(opts.corpusKey);
  let removedRecords = 0;
  const seen = new Set<string>();
  for (const v of all) {
    if (seen.has(v.fileId)) continue;
    if (!opts.liveFileIds.has(v.fileId)) {
      removedRecords += await removeVectorsForFile(v.fileId, opts.corpusKey);
      seen.add(v.fileId);
    }
  }
  return removedRecords;
}

export interface NeuralHit {
  fileId: string;
  score: number;
  snippet: string;
  chunkIdx: number;
}

export function rankVectorsByQueryEmbedding(
  queryEmbedding: number[],
  vectors: VectorRecord[],
  opts?: {
    embeddingModel?: string;
    embeddingVersion?: string;
    dimension?: number;
    minScore?: number;
    topK?: number;
    liveFileIds?: Set<string>;
  }
): NeuralHit[] {
  const model = opts?.embeddingModel ?? EMBED_CONFIG.model;
  const version = opts?.embeddingVersion ?? EMBED_CONFIG.version;
  const dimension = opts?.dimension ?? EMBED_CONFIG.dimension;
  const minScore = opts?.minScore ?? 0.25;
  const topK = opts?.topK ?? 50;
  const live = opts?.liveFileIds;

  if (!queryEmbedding.length || queryEmbedding.length !== dimension) {
    return [];
  }

  const best = new Map<string, NeuralHit>();
  for (const v of vectors) {
    if (live && !live.has(v.fileId)) continue;
    if (v.embeddingModel !== model) continue;
    if (v.embeddingVersion !== version) continue;
    if (v.dimension !== dimension) continue;
    if (!Array.isArray(v.embedding) || v.embedding.length !== dimension) continue;

    const sim = cosineSimilarity(queryEmbedding, v.embedding);
    if (sim < minScore) continue;

    const prev = best.get(v.fileId);
    if (!prev || sim > prev.score) {
      best.set(v.fileId, {
        fileId: v.fileId,
        score: sim,
        snippet: (v.text || '').slice(0, 160).trim(),
        chunkIdx: v.idx,
      });
    }
  }

  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, topK);
}

export async function searchNeuralByEmbedding(
  queryEmbedding: number[],
  corpusKey: string,
  opts?: { minScore?: number; topK?: number; liveFileIds?: Set<string> }
): Promise<NeuralHit[]> {
  const vectors = await listVectors(corpusKey);
  return rankVectorsByQueryEmbedding(queryEmbedding, vectors, {
    minScore: opts?.minScore,
    topK: opts?.topK,
    liveFileIds: opts?.liveFileIds,
  });
}
