import { describe, it, expect } from 'vitest';
import { rankVectorsByQueryEmbedding, type VectorRecord } from '../vectorIndex';
import { neuralToDisplayScore } from '../searchEngine';
import { cosineSimilarity } from '../embeddings/vector';

function vec(seed: number, dim = 768): number[] {
  const out = new Array(dim).fill(0);
  for (let i = 0; i < dim; i++) {
    out[i] = Math.sin(seed * 0.01 + i * 0.003);
  }
  return out;
}

function rec(
  fileId: string,
  idx: number,
  embedding: number[],
  text: string
): VectorRecord {
  return {
    id: fileId + '#' + idx,
    fileId,
    idx,
    text,
    embedding,
    corpusKey: 'user',
    contentHash: 'h' + idx,
    embeddingModel: 'gemini-embedding-2',
    embeddingVersion: '3',
    dimension: 768,
    indexedAt: new Date().toISOString(),
  };
}

describe('rankVectorsByQueryEmbedding', () => {
  it('ranks employment-crisis doc above pickle for unemployment-like query vector', () => {
    const unemploymentDir = vec(42);
    const employmentDoc = rec(
      'emp1',
      0,
      unemploymentDir.map(x => x * 0.98),
      'The country is facing a severe employment crisis and increasing joblessness.'
    );
    const pickleDoc = rec(
      'pic1',
      0,
      vec(999),
      'A recipe for mango pickle with mustard oil.'
    );
    const hits = rankVectorsByQueryEmbedding(unemploymentDir, [employmentDoc, pickleDoc], {
      minScore: 0.2,
      topK: 10,
    });
    expect(hits[0]?.fileId).toBe('emp1');
    expect(hits[0]?.score).toBeGreaterThan(0.9);
    const pickle = hits.find(h => h.fileId === 'pic1');
    if (pickle) {
      expect(pickle.score).toBeLessThan(hits[0].score);
    }
  });

  it('skips wrong model vectors', () => {
    const q = vec(1);
    const bad = rec('x', 0, q, 'text');
    bad.embeddingModel = 'old-model';
    const hits = rankVectorsByQueryEmbedding(q, [bad], { minScore: 0.1 });
    expect(hits.length).toBe(0);
  });

  it('skips version-1 vectors after the embedding contract migration', () => {
    const q = vec(1);
    const old = rec('old', 0, q, 'old vector');
    old.embeddingVersion = '1';
    expect(rankVectorsByQueryEmbedding(q, [old], { minScore: 0.1 })).toEqual([]);
  });

  it('aggregates max chunk score per file', () => {
    const q = vec(7);
    const low = rec('f', 0, vec(100), 'weak');
    const high = rec('f', 1, q.map(x => x), 'strong match chunk');
    const hits = rankVectorsByQueryEmbedding(q, [low, high], { minScore: 0.1 });
    expect(hits.length).toBe(1);
    expect(hits[0].chunkIdx).toBe(1);
    expect(hits[0].snippet).toContain('strong match');
  });

  it('does not discard a valid low-cosine vector by default', () => {
    const q = vec(11);
    const low = rec('low', 0, vec(12), 'lower semantic similarity');
    const hits = rankVectorsByQueryEmbedding(q, [low]);
    expect(hits).toHaveLength(1);
  });
});

describe('neuralToDisplayScore', () => {
  it('maps 1 → 100 and negative → 0', () => {
    expect(neuralToDisplayScore(1)).toBe(100);
    expect(neuralToDisplayScore(0.5)).toBe(50);
    expect(neuralToDisplayScore(-0.2)).toBe(0);
  });
});

describe('cosine baseline', () => {
  it('identical vectors ≈ 1', () => {
    const v = vec(3);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 5);
  });
});
