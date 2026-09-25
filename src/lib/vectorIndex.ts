/**
 * IndexedDB vector store with versioned sparse random-hyperplane LSH buckets.
 * Vectors remain the source of truth; ANN buckets are a rebuildable acceleration index.
 */
import type { EmbeddingProvider } from './embeddings/types';
import { EMBED_CONFIG } from './embeddings/config';
import { cosineSimilarity } from './embeddings/vector';

const DB_NAME = 'drive-vector-index';
const DB_VERSION = 2;
const VECTOR_STORE = 'vectors';
const ANN_META_STORE = 'annMetadata';
const ANN_INDEX_VERSION = 'sparse-rp-lsh-v2-scoped';
const ANN_TABLES = 12;
const ANN_BITS_PER_TABLE = 12;
const ANN_DIMS_PER_PLANE = 8;
const DEFAULT_EXACT_SEARCH_THRESHOLD = 128;
const ANN_META_ID_PREFIX = 'ann-index:';

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
  /** Multi-entry IndexedDB index entries; derived and safe to rebuild. */
  annBuckets?: string[];
  driveModifiedTime?: string;
  indexedAt: string;
}

interface AnnMetadataRecord {
  id: string;
  version: string;
  indexedAt: string;
}

interface ProjectionPlane {
  indices: Uint16Array;
  signs: Int8Array;
}

interface AnnProbe {
  bucket: string;
  margin: number;
}

const projectionCache = new Map<number, ProjectionPlane[][]>();
const annIndexPromises = new Map<string, Promise<void>>();
const ANN_LOCK_PREFIX = 'drive-semantic-ann-migration:';

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
      let store: IDBObjectStore;
      if (!db.objectStoreNames.contains(VECTOR_STORE)) {
        store = db.createObjectStore(VECTOR_STORE, { keyPath: 'id' });
        store.createIndex('fileId', 'fileId', { unique: false });
        store.createIndex('corpusKey', 'corpusKey', { unique: false });
        store.createIndex('contentHash', 'contentHash', { unique: false });
      } else {
        store = req.transaction!.objectStore(VECTOR_STORE);
      }
      if (!store.indexNames.contains('annBuckets')) {
        store.createIndex('annBuckets', 'annBuckets', { unique: false, multiEntry: true });
      }
      if (!db.objectStoreNames.contains(ANN_META_STORE)) {
        db.createObjectStore(ANN_META_STORE, { keyPath: 'id' });
      }
    };
  });
}

/** Stable PRNG so every browser derives identical projection planes. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function getProjectionPlanes(dimension: number): ProjectionPlane[][] {
  const cached = projectionCache.get(dimension);
  if (cached) return cached;
  const planes: ProjectionPlane[][] = [];
  for (let table = 0; table < ANN_TABLES; table++) {
    const tablePlanes: ProjectionPlane[] = [];
    for (let bit = 0; bit < ANN_BITS_PER_TABLE; bit++) {
      const random = mulberry32(
        0x51f15e + dimension * 97 + table * 7919 + bit * 104729
      );
      const indices = new Uint16Array(ANN_DIMS_PER_PLANE);
      const signs = new Int8Array(ANN_DIMS_PER_PLANE);
      for (let i = 0; i < ANN_DIMS_PER_PLANE; i++) {
        indices[i] = Math.floor(random() * dimension);
        signs[i] = random() < 0.5 ? -1 : 1;
      }
      tablePlanes.push({ indices, signs });
    }
    planes.push(tablePlanes);
  }
  projectionCache.set(dimension, planes);
  return planes;
}

function getAnnProbes(vector: ArrayLike<number>): AnnProbe[][] {
  if (vector.length !== EMBED_CONFIG.dimension) return [];
  for (let i = 0; i < vector.length; i++) {
    if (!Number.isFinite(vector[i])) return [];
  }
  const planes = getProjectionPlanes(vector.length);
  return planes.map((tablePlanes, tableIdx) => {
    let bits = 0;
    const margins: number[] = [];
    for (let bit = 0; bit < tablePlanes.length; bit++) {
      const plane = tablePlanes[bit];
      let projection = 0;
      for (let i = 0; i < plane.indices.length; i++) {
        projection += vector[plane.indices[i]] * plane.signs[i];
      }
      if (projection >= 0) bits |= 1 << bit;
      margins.push(Math.abs(projection));
    }
    const nearestBit = margins.reduce(
      (best, margin, bit) => (margin < margins[best] ? bit : best),
      0
    );
    const prefix = `${ANN_INDEX_VERSION}:${tableIdx}:`;
    const mask = 1 << nearestBit;
    return [
      { bucket: `${prefix}${bits}`, margin: 0 },
      { bucket: `${prefix}${bits ^ mask}`, margin: margins[nearestBit] },
    ];
  });
}

function annBucketKeys(vector: ArrayLike<number>, corpusKey: string): string[] {
  const scope = encodeURIComponent(corpusKey);
  return getAnnProbes(vector).flatMap((table, tableIdx) =>
    table.map(probe => `${ANN_INDEX_VERSION}:${scope}:${tableIdx}:${probe.bucket.split(':').at(-1)}`)
  );
}

/** Exported for deterministic tests and the offline relevance evaluator. */
export function getAnnProbeBucketKeys(queryEmbedding: number[], corpusKey = ''): string[] {
  return annBucketKeys(queryEmbedding, corpusKey);
}

/**
 * One-time, streaming backfill for existing v1 records. This uses an IndexedDB
 * cursor and stores only derived bucket keys, never loading the corpus at once.
 */
async function ensureAnnIndex(corpusKey: string): Promise<void> {
  if (annIndexPromises.has(corpusKey)) return annIndexPromises.get(corpusKey)!;
  const migrate = async () => {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([VECTOR_STORE, ANN_META_STORE], 'readwrite');
      const vectors = tx.objectStore(VECTOR_STORE);
      const metadata = tx.objectStore(ANN_META_STORE);
      const metaId = ANN_META_ID_PREFIX + corpusKey;
      let migrationError: unknown;
      const metaReq = metadata.get(metaId);
      metaReq.onsuccess = () => {
        const saved = metaReq.result as AnnMetadataRecord | undefined;
        if (saved?.version === ANN_INDEX_VERSION) return;
        const cursorReq = vectors.index('corpusKey').openCursor(IDBKeyRange.only(corpusKey));
        cursorReq.onerror = () => {
          migrationError = cursorReq.error || new Error('ANN index cursor failed');
          try { tx.abort(); } catch { /* transaction already ended */ }
        };
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor) {
            metadata.put({ id: metaId, version: ANN_INDEX_VERSION, indexedAt: new Date().toISOString() });
            return;
          }
          const record = cursor.value as VectorRecord;
          cursor.update({ ...record, annBuckets: annBucketKeys(record.embedding, corpusKey) });
          cursor.continue();
        };
      };
      metaReq.onerror = () => {
        migrationError = metaReq.error || new Error('ANN metadata lookup failed');
        try { tx.abort(); } catch { /* transaction already ended */ }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(migrationError || tx.error || new Error('ANN index migration failed'));
      tx.onabort = () => reject(migrationError || tx.error || new Error('ANN index migration aborted'));
    });
  };
  const indexing = (async () => {
    // Coordinate tabs when Web Locks is available; older/private contexts
    // retain the transaction-level fallback and remain fully functional.
    if (typeof navigator !== 'undefined' && navigator.locks?.request) {
      await navigator.locks.request(ANN_LOCK_PREFIX + corpusKey, { mode: 'exclusive' }, migrate);
      return;
    }
    await migrate();
  })();
  annIndexPromises.set(corpusKey, indexing);
  try {
    await indexing;
  } catch (error) {
    annIndexPromises.delete(corpusKey);
    throw error;
  }
}

/** Warm the derived ANN index without blocking the current search interaction. */
export async function warmAnnIndex(corpusKey: string): Promise<void> {
  try {
    await ensureAnnIndex(corpusKey);
  } catch (error) {
    console.warn('[vectorIndex] background ANN warm-up failed', error);
  }
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
    return new Promise((resolve, reject) => {
      const store = db.transaction(VECTOR_STORE, 'readonly').objectStore(VECTOR_STORE);
      const req = corpusKey ? store.index('corpusKey').getAll(corpusKey) : store.getAll();
      req.onsuccess = () => resolve((req.result || []) as VectorRecord[]);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

export async function countVectors(corpusKey?: string): Promise<number> {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const store = db.transaction(VECTOR_STORE, 'readonly').objectStore(VECTOR_STORE);
      const req = corpusKey ? store.index('corpusKey').count(corpusKey) : store.count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return 0;
  }
}

async function getVectorsForAnnBuckets(bucketKeys: string[]): Promise<VectorRecord[]> {
  if (!bucketKeys.length) return [];
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(VECTOR_STORE, 'readonly');
    const index = tx.objectStore(VECTOR_STORE).index('annBuckets');
    const records = new Map<string, VectorRecord>();
    let requestError: unknown;
    for (const key of bucketKeys) {
      const req = index.getAll(IDBKeyRange.only(key));
      req.onsuccess = () => {
        for (const record of (req.result || []) as VectorRecord[]) records.set(record.id, record);
      };
      req.onerror = () => { requestError = req.error || new Error('ANN bucket lookup failed'); };
    }
    tx.oncomplete = () => resolve([...records.values()]);
    tx.onerror = () => reject(requestError || tx.error || new Error('ANN bucket lookup failed'));
    tx.onabort = () => reject(requestError || tx.error || new Error('ANN bucket lookup aborted'));
  });
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

  if (!toEmbed.length) return { stored: 0, skipped, failed: false };

  const batchSize = EMBED_CONFIG.maxTextsPerBatch;
  const newRecords: VectorRecord[] = [];
  try {
    for (let i = 0; i < toEmbed.length; i += batchSize) {
      const batch = toEmbed.slice(i, i + batchSize);
      const vectors = await provider.embedDocuments(batch.map(b => b.text));
      if (vectors.length !== batch.length) throw new Error('embed batch length mismatch');
      const now = new Date().toISOString();
      for (let j = 0; j < batch.length; j++) {
        const emb = vectors[j];
        if (!emb || emb.length !== dimension || emb.some(value => !Number.isFinite(value))) {
          throw new Error('embed dimension or value mismatch');
        }
        const b = batch[j];
        newRecords.push({
          id: corpusKey + '::' + fileId + '#' + b.idx,
          fileId,
          idx: b.idx,
          text: b.text.slice(0, 2000),
          embedding: emb,
          annBuckets: annBucketKeys(emb, corpusKey),
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
      const store = tx.objectStore(VECTOR_STORE);
      for (const rec of newRecords) store.put(rec);
      for (const prev of existing) {
        if (!newRecords.some(rec => rec.id === prev.id)) store.delete(prev.id);
      }
      const maxIdx = chunks.length;
      for (const prev of existing) {
        if (prev.idx >= maxIdx) store.delete(prev.id);
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
  const minScore = opts?.minScore ?? -1;
  const topK = opts?.topK ?? 200;
  const live = opts?.liveFileIds;
  if (!queryEmbedding.length || queryEmbedding.length !== dimension || queryEmbedding.some(v => !Number.isFinite(v))) {
    return [];
  }

  const best = new Map<string, NeuralHit>();
  for (const v of vectors) {
    if (live && !live.has(v.fileId)) continue;
    if (v.embeddingModel !== model || v.embeddingVersion !== version || v.dimension !== dimension) continue;
    if (!Array.isArray(v.embedding) || v.embedding.length !== dimension || v.embedding.some(x => !Number.isFinite(x))) continue;
    const sim = cosineSimilarity(queryEmbedding, v.embedding);
    if (!Number.isFinite(sim) || sim < minScore) continue;
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

export interface AnnSearchMetrics {
  totalVectors: number;
  candidateVectors: number;
  usedAnn: boolean;
  bucketsRead: number;
  usedExactFallback: boolean;
  fallbackReason?: 'empty-candidates' | 'no-qualified-hits';
}

export async function searchNeuralByEmbedding(
  queryEmbedding: number[],
  corpusKey: string,
  opts?: {
    minScore?: number;
    topK?: number;
    liveFileIds?: Set<string>;
    exactSearchThreshold?: number;
    /** Run an exact corpus scan when ANN returns no usable result. Enabled by default. */
    exactFallback?: boolean;
    onMetrics?: (metrics: AnnSearchMetrics) => void;
  }
): Promise<NeuralHit[]> {
  const totalVectors = await countVectors(corpusKey);
  const exactSearchThreshold = opts?.exactSearchThreshold ?? DEFAULT_EXACT_SEARCH_THRESHOLD;
  const exact = totalVectors <= exactSearchThreshold;
  let vectors: VectorRecord[];
  let bucketsRead = 0;
  if (exact) {
    vectors = await listVectors(corpusKey);
  } else {
    await ensureAnnIndex(corpusKey);
    const keys = annBucketKeys(queryEmbedding, corpusKey);
    bucketsRead = keys.length;
    vectors = await getVectorsForAnnBuckets(keys);
  }
  const usedAnn = !exact;
  const annHits = rankVectorsByQueryEmbedding(queryEmbedding, vectors, {
    minScore: opts?.minScore,
    topK: opts?.topK,
    liveFileIds: opts?.liveFileIds,
  });
  const shouldFallback = usedAnn && (opts?.exactFallback ?? true) && annHits.length === 0;
  if (shouldFallback) {
    const exactVectors = await listVectors(corpusKey);
    const exactHits = rankVectorsByQueryEmbedding(queryEmbedding, exactVectors, {
      minScore: opts?.minScore,
      topK: opts?.topK,
      liveFileIds: opts?.liveFileIds,
    });
    opts?.onMetrics?.({
      totalVectors,
      candidateVectors: vectors.length,
      usedAnn: true,
      bucketsRead,
      usedExactFallback: true,
      fallbackReason: vectors.length === 0 ? 'empty-candidates' : 'no-qualified-hits',
    });
    return exactHits;
  }
  opts?.onMetrics?.({
    totalVectors,
    candidateVectors: vectors.length,
    usedAnn,
    bucketsRead,
    usedExactFallback: false,
  });
  return annHits;
}
