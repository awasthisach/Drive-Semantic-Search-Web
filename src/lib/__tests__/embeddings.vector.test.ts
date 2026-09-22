import { describe, it, expect } from 'vitest';
import { cosineSimilarity, l2Normalize } from '../embeddings/vector';

describe('cosineSimilarity', () => {
  it('identical unit vectors → 1', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1, 5);
  });
  it('orthogonal → 0', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 5);
  });
  it('opposite → -1', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 5);
  });
});

describe('l2Normalize', () => {
  it('unit length', () => {
    const v = l2Normalize([3, 4]);
    const n = Math.sqrt(v[0] * v[0] + v[1] * v[1]);
    expect(n).toBeCloseTo(1, 5);
  });
});
