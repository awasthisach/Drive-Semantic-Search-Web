import 'fake-indexeddb/auto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  getAnnProbeBucketKeys,
  rankVectorsByQueryEmbedding,
  searchNeuralByEmbedding,
  type VectorRecord,
} from '../vectorIndex';
import { EMBED_CONFIG } from '../embeddings/config';

const DB_NAME = 'drive-vector-index';
const DB_VERSION = 2;
const VECTOR_STORE = 'vectors';
const ANN_META_STORE = 'annMetadata';
const CORPUS_KEY = 'ann-relevance-evaluation';
const FALLBACK_CORPUS_KEY = 'ann-exact-fallback';
const TOPIC_COUNT = 8;
const DOCS_PER_TOPIC = 10;
const TOP_K = 5;

interface BenchmarkTopic {
  id: string;
  query: string;
  label: string;
}

// Fixed, labeled topical fixture. The vectors deliberately model well-separated
// clusters so the test can measure ANN recall against an exact cosine oracle;
// it is an algorithm regression test, not a claim about live Drive relevance.
const TOPICS: BenchmarkTopic[] = [
  { id: 'auth', query: 'How do sign-in tokens expire and refresh?', label: 'Authentication' },
  { id: 'search', query: 'How are documents ranked by semantic similarity?', label: 'Search ranking' },
  { id: 'vault', query: 'How is encrypted offline data protected?', label: 'Encrypted vault' },
  { id: 'sync', query: 'How does Drive synchronization detect changes?', label: 'Drive sync' },
  { id: 'duplicates', query: 'How are duplicate files detected safely?', label: 'Duplicate detection' },
  { id: 'storage', query: 'How is browser storage quota managed?', label: 'Browser storage' },
  { id: 'worker', query: 'How does the embedding Worker validate requests?', label: 'Embedding Worker' },
  { id: 'accessibility', query: 'How do keyboard and screen reader controls work?', label: 'Accessibility' },
];

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function normalize(vector: number[]): number[] {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return vector.map(value => value / magnitude);
}

const DIMENSION = EMBED_CONFIG.dimension;
const CENTROIDS = TOPICS.map((_, topicIdx) => {
  const random = seededRandom(0x5eed + topicIdx * 31337);
  return normalize(Array.from({ length: DIMENSION }, () => random() * 2 - 1));
});

function makeEmbedding(topicIdx: number, documentIdx: number): number[] {
  const random = seededRandom(0xc0ffee + topicIdx * 104729 + documentIdx * 7919);
  return normalize(CENTROIDS[topicIdx].map(value => value + (random() * 2 - 1) * 0.015));
}

function makeRecord(topicIdx: number, documentIdx: number): VectorRecord {
  const topic = TOPICS[topicIdx];
  const fileId = `${topic.id}-${String(documentIdx + 1).padStart(2, '0')}`;
  return {
    id: `${CORPUS_KEY}::${fileId}#0`,
    fileId,
    idx: 0,
    text: `${topic.label} implementation note ${documentIdx + 1}`,
    embedding: makeEmbedding(topicIdx, documentIdx),
    corpusKey: CORPUS_KEY,
    contentHash: `fixture-${fileId}`,
    embeddingModel: EMBED_CONFIG.model,
    embeddingVersion: EMBED_CONFIG.version,
    dimension: DIMENSION,
    indexedAt: '2026-01-01T00:00:00.000Z',
    // Intentionally omitted: migration must backfill old v1 records.
  };
}

function openFixtureDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(VECTOR_STORE)) {
        const store = db.createObjectStore(VECTOR_STORE, { keyPath: 'id' });
        store.createIndex('fileId', 'fileId', { unique: false });
        store.createIndex('corpusKey', 'corpusKey', { unique: false });
        store.createIndex('contentHash', 'contentHash', { unique: false });
        store.createIndex('annBuckets', 'annBuckets', { unique: false, multiEntry: true });
      }
      if (!db.objectStoreNames.contains('annMetadata')) {
        db.createObjectStore('annMetadata', { keyPath: 'id' });
      }
    };
  });
}

function seedRecords(records: VectorRecord[]): Promise<void> {
  return openFixtureDb().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(VECTOR_STORE, 'readwrite');
    const store = tx.objectStore(VECTOR_STORE);
    for (const record of records) store.put(record);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  }));
}

function markAnnIndexCurrent(corpusKey: string): Promise<void> {
  return openFixtureDb().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(ANN_META_STORE, 'readwrite');
    tx.objectStore(ANN_META_STORE).put({
      id: `ann-index:${corpusKey}`,
      version: 'sparse-rp-lsh-v2-scoped',
      indexedAt: '2026-01-01T00:00:00.000Z',
    });
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  }));
}

function precisionAt(results: string[], expected: Set<string>, k: number): number {
  return results.slice(0, k).filter(id => expected.has(id)).length / k;
}

function recallAt(results: string[], expected: Set<string>, k: number): number {
  return results.slice(0, k).filter(id => expected.has(id)).length / expected.size;
}

function reciprocalRank(results: string[], expected: Set<string>): number {
  const rank = results.findIndex(id => expected.has(id));
  return rank < 0 ? 0 : 1 / (rank + 1);
}

describe('IndexedDB ANN relevance and retrieval evaluation', () => {
  let records: VectorRecord[];

  beforeAll(async () => {
    records = TOPICS.flatMap((_, topicIdx) =>
      Array.from({ length: DOCS_PER_TOPIC }, (_, docIdx) => makeRecord(topicIdx, docIdx))
    );
    await seedRecords(records);
  });

  it('uses stable, non-empty bucket signatures for valid embeddings', () => {
    const query = makeEmbedding(0, 0);
    const first = getAnnProbeBucketKeys(query);
    expect(first.length).toBeGreaterThan(0);
    expect(getAnnProbeBucketKeys(query)).toEqual(first);
    expect(getAnnProbeBucketKeys(query, 'user-a')).not.toEqual(
      getAnnProbeBucketKeys(query, 'user-b')
    );
    expect(getAnnProbeBucketKeys([1, 2, 3])).toEqual([]);
  });

  it('keeps exact search for corpora below the configured threshold', async () => {
    const queryEmbedding = CENTROIDS[0];
    let metrics: { totalVectors: number; candidateVectors: number; usedAnn: boolean; bucketsRead: number } | undefined;
    const exact = await searchNeuralByEmbedding(queryEmbedding, CORPUS_KEY, {
      onMetrics: value => { metrics = value; },
    });
    expect(metrics?.usedAnn).toBe(false);
    expect(metrics?.candidateVectors).toBe(metrics?.totalVectors);
    expect(exact[0]?.fileId.startsWith(`${TOPICS[0].id}-`)).toBe(true);
  });

  it('backfills a legacy corpus, retrieves candidates only, and preserves exact top-topic relevance', async () => {
    const precisions: number[] = [];
    const recalls: number[] = [];
    const reciprocalRanks: number[] = [];
    const candidateRatios: number[] = [];

    for (let topicIdx = 0; topicIdx < TOPICS.length; topicIdx++) {
      const queryEmbedding = CENTROIDS[topicIdx];
      const expectedIds = new Set(
        records.filter(record => record.fileId.startsWith(`${TOPICS[topicIdx].id}-`)).map(record => record.fileId)
      );
      const exact = rankVectorsByQueryEmbedding(queryEmbedding, records, { topK: 10 });
      let metrics: { totalVectors: number; candidateVectors: number; usedAnn: boolean; bucketsRead: number } | undefined;
      const approximate = await searchNeuralByEmbedding(queryEmbedding, CORPUS_KEY, {
        exactSearchThreshold: 0,
        topK: 10,
        onMetrics: value => { metrics = value; },
      });
      const exactIds = exact.map(hit => hit.fileId);
      const approximateIds = approximate.map(hit => hit.fileId);
      const expectedTop = new Set(exactIds.slice(0, 10));
      const annRecall = approximateIds.filter(id => expectedTop.has(id)).length / expectedTop.size;
      const pAt5 = precisionAt(approximateIds, expectedIds, TOP_K);
      const rAt10 = recallAt(approximateIds, expectedIds, 10);
      const mrr = reciprocalRank(approximateIds, expectedIds);

      expect(metrics).toBeDefined();
      expect(metrics?.usedAnn).toBe(true);
      expect(metrics?.totalVectors).toBe(TOPIC_COUNT * DOCS_PER_TOPIC);
      expect(metrics?.candidateVectors).toBeLessThan(metrics!.totalVectors);
      expect(approximate.length).toBeGreaterThan(0);
      expect(annRecall).toBeGreaterThanOrEqual(0.8);
      expect(pAt5).toBeGreaterThanOrEqual(0.8);
      expect(rAt10).toBeGreaterThanOrEqual(0.8);
      expect(mrr).toBe(1);

      precisions.push(pAt5);
      recalls.push(rAt10);
      reciprocalRanks.push(mrr);
      candidateRatios.push(metrics!.candidateVectors / metrics!.totalVectors);
    }

    const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
    const report = {
      fixture: '8 labeled topical clusters × 10 documents (deterministic ANN regression fixture)',
      queries: TOPICS.length,
      vectors: records.length,
      pAt5: Number(average(precisions).toFixed(3)),
      recallAt10: Number(average(recalls).toFixed(3)),
      mrr: Number(average(reciprocalRanks).toFixed(3)),
      averageCandidateFraction: Number(average(candidateRatios).toFixed(3)),
      averageCandidateReduction: `${Math.round((1 - average(candidateRatios)) * 100)}%`,
    };
    console.info(`ANN_RELEVANCE_REPORT ${JSON.stringify(report)}`);
  });

  it('falls back to exact search when an ANN index has no candidates', async () => {
    const record = {
      ...makeRecord(0, 0),
      id: `${FALLBACK_CORPUS_KEY}::fallback#0`,
      fileId: 'fallback',
      corpusKey: FALLBACK_CORPUS_KEY,
      annBuckets: undefined,
    };
    await seedRecords([record]);
    // Simulate a current-but-empty derived index after a partial migration.
    await markAnnIndexCurrent(FALLBACK_CORPUS_KEY);

    let metrics: {
      totalVectors: number;
      candidateVectors: number;
      usedAnn: boolean;
      bucketsRead: number;
      usedExactFallback: boolean;
      fallbackReason?: string;
    } | undefined;
    const results = await searchNeuralByEmbedding(CENTROIDS[0], FALLBACK_CORPUS_KEY, {
      exactSearchThreshold: 0,
      onMetrics: value => { metrics = value; },
    });

    expect(results[0]?.fileId).toBe('fallback');
    expect(metrics?.usedAnn).toBe(true);
    expect(metrics?.candidateVectors).toBe(0);
    expect(metrics?.usedExactFallback).toBe(true);
    expect(metrics?.fallbackReason).toBe('empty-candidates');
  });
});
