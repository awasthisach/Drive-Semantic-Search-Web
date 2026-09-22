/**
 * Phase 3b — IndexedDB vector store (independent of BM25 postings).
 * Same contentHash + model + version + dimension → skip re-embed.
 * API failure must not delete existing valid vectors.
 */
import type { EmbeddingProvider } from './embeddings/types';
import { EMBED_CONFIG } from './embeddings/config';

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

/** SHA-256 hex of UTF-8 text (chunk identity). */
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

export async function getVectorsForFile(fileId: string): Promise<VectorRecord[]> {
  try {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const req = db
        .transaction(VECTOR_STORE, 'readonly')
        .objectStore(VECTOR_STORE)
        .index('fileId')
        .getAll(fileId);
      req.onsuccess = () => resolve((req.result || []) as VectorRecord[]);
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

/** Remove all vectors for a file. Safe no-op if missing. */
export async function removeVectorsForFile(fileId: string): Promise<number> {
  try {
    const existing = await getVectorsForFile(fileId);
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

/**
 * Embed chunks and store vectors. Skips chunks that already match
 * contentHash+model+version+dimension. On embed API failure, existing
 * compatible vectors for that file are left intact (no partial wipe).
 */
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

  const existing = await getVectorsForFile(fileId);
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
          id: fileId + '#' + b.idx,
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

/** Prune vectors whose fileId is not in live set (corpus-scoped). */
export async function pruneMissingVectors(opts: {
  liveFileIds: Set<string>;
  corpusKey?: string;
  complete: boolean;
}): Promise<number> {
  if (!opts.complete) return 0;
  const all = await listVectors(opts.corpusKey);
  let removed = 0;
  const seen = new Set<string>();
  for (const v of all) {
    if (seen.has(v.fileId)) continue;
    if (!opts.liveFileIds.has(v.fileId)) {
      await removeVectorsForFile(v.fileId);
      seen.add(v.fileId);
      removed++;
    }
  }
  return removed;
}
