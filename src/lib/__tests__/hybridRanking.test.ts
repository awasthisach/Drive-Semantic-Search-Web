import { describe, it, expect } from 'vitest';
import {
  HYBRID_WEIGHTS,
  LEXICAL_FLOOR_WEIGHT,
  neuralToDisplayScore,
  scoreNeuralHybridCandidate,
} from '../searchEngine';

describe('neural pipeline hybrid score', () => {
  it('floors a strong BM25-only file so a neural hit on another file cannot bury it', () => {
    const score = scoreNeuralHybridCandidate(0, 80, 20);
    const oldWeightedScore = Math.round(
      HYBRID_WEIGHTS.bm25 * 80 + HYBRID_WEIGHTS.metadata * 20
    );
    const floor = Math.round(
      LEXICAL_FLOOR_WEIGHT * 80 + HYBRID_WEIGHTS.metadata * 20
    );

    expect(oldWeightedScore).toBe(24);
    expect(floor).toBe(44);
    expect(score).toBe(floor);
    expect(score).toBeGreaterThan(oldWeightedScore);
  });

  it('does not apply the lexical floor to a file that has a neural hit', () => {
    const score = scoreNeuralHybridCandidate(90, 10, 0);
    expect(score).toBe(
      Math.round(HYBRID_WEIGHTS.neural * 90 + HYBRID_WEIGHTS.bm25 * 10)
    );
  });

  it('does not apply a BM25 floor when there is no BM25 signal', () => {
    const score = scoreNeuralHybridCandidate(0, 0, 80);
    expect(score).toBe(Math.round(HYBRID_WEIGHTS.metadata * 80));
  });
});

describe('neuralToDisplayScore', () => {
  it('is bounded', () => {
    expect(neuralToDisplayScore(1.2)).toBe(100);
    expect(neuralToDisplayScore(-1)).toBe(0);
  });
});
