import { describe, it, expect } from 'vitest';
import { isCompatibleVector, type VectorRecord } from '../vectorIndex';

function sample(over: Partial<VectorRecord> = {}): VectorRecord {
  return {
    id: 'f#0',
    fileId: 'f',
    idx: 0,
    text: 'hello',
    embedding: new Array(768).fill(0.1),
    corpusKey: 'user',
    contentHash: 'abc',
    embeddingModel: 'gemini-embedding-2',
    embeddingVersion: '2',
    dimension: 768,
    indexedAt: new Date().toISOString(),
    ...over,
  };
}

describe('isCompatibleVector', () => {
  it('accepts matching fingerprint', () => {
    const v = sample();
    expect(isCompatibleVector(v, 'abc', 'gemini-embedding-2', '2', 768)).toBe(true);
  });
  it('rejects model change', () => {
    const v = sample();
    expect(isCompatibleVector(v, 'abc', 'other-model', '2', 768)).toBe(false);
  });
  it('rejects content change', () => {
    const v = sample();
    expect(isCompatibleVector(v, 'zzz', 'gemini-embedding-2', '2', 768)).toBe(false);
  });
  it('rejects wrong dimension length', () => {
    const v = sample({ embedding: [1, 2, 3], dimension: 768 });
    expect(isCompatibleVector(v, 'abc', 'gemini-embedding-2', '2', 768)).toBe(false);
  });
  it('rejects version-1 vectors during the version-2 migration', () => {
    const v = sample({ embeddingVersion: '1' });
    expect(isCompatibleVector(v, 'abc', 'gemini-embedding-2', '2', 768)).toBe(false);
  });
});
