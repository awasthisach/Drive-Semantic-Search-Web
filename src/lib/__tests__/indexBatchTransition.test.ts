import { describe, expect, it } from 'vitest';
import { getIndexBatchTransition } from '../indexBatchTransition';

describe('automatic bounded index batch continuation', () => {
  it('continues from file 51 after the first successful 50-file batch', () => {
    const firstBatch = getIndexBatchTransition({
      total: 123,
      batchEnd: 50,
      contiguousCursor: 50,
      failures: 0,
      cancelled: false,
      aborted: false,
    });

    expect(firstBatch).toEqual({ kind: 'continue', resumeFrom: 50 });

    const secondBatch = getIndexBatchTransition({
      total: 123,
      batchEnd: 100,
      contiguousCursor: 100,
      failures: 0,
      cancelled: false,
      aborted: false,
    });
    expect(secondBatch).toEqual({ kind: 'continue', resumeFrom: 100 });

    const finalBatch = getIndexBatchTransition({
      total: 123,
      batchEnd: 123,
      contiguousCursor: 123,
      failures: 0,
      cancelled: false,
      aborted: false,
    });
    expect(finalBatch).toEqual({ kind: 'done' });
  });

  it('pauses at the contiguous cursor when a file fails so it can be retried', () => {
    expect(getIndexBatchTransition({
      total: 123,
      batchEnd: 50,
      contiguousCursor: 27,
      failures: 1,
      cancelled: false,
      aborted: false,
    })).toEqual({ kind: 'retry', resumeFrom: 27 });
  });

  it('does not schedule another batch after cancellation or abort', () => {
    const cancelled = getIndexBatchTransition({
      total: 123,
      batchEnd: 50,
      contiguousCursor: 50,
      failures: 0,
      cancelled: true,
      aborted: false,
    });
    const aborted = getIndexBatchTransition({
      total: 123,
      batchEnd: 50,
      contiguousCursor: 50,
      failures: 0,
      cancelled: false,
      aborted: true,
    });

    expect(cancelled).toEqual({ kind: 'stopped' });
    expect(aborted).toEqual({ kind: 'stopped' });
  });
});
