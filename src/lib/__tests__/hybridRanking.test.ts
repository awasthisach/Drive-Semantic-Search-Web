import { describe, it, expect } from 'vitest';
import { HYBRID_WEIGHTS, neuralToDisplayScore } from '../searchEngine';

/** Mirrors fixed hybrid formula for neuralPipelineOk. */
function hybridScore(neuralN: number, bm25N: number, metaN: number): number {
  return Math.round(
    HYBRID_WEIGHTS.neural * neuralN +
      HYBRID_WEIGHTS.bm25 * bm25N +
      HYBRID_WEIGHTS.metadata * metaN
  );
}

describe('hybrid formula when neural pipeline ok', () => {
  it('BM25-only file still gets hybrid-weighted BM25 (neuralN=0)', () => {
    const s = hybridScore(0, 80, 20);
    expect(s).toBe(
      Math.round(0.55 * 0 + 0.25 * 80 + 0.2 * 20)
    );
    expect(s).toBe(24);
  });

  it('strong neural dominates', () => {
    const s = hybridScore(90, 10, 0);
    expect(s).toBe(Math.round(0.55 * 90 + 0.25 * 10));
  });
});

describe('neuralToDisplayScore', () => {
  it('is bounded', () => {
    expect(neuralToDisplayScore(1.2)).toBe(100);
    expect(neuralToDisplayScore(-1)).toBe(0);
  });
});
