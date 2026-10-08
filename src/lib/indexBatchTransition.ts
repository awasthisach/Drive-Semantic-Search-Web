export interface IndexBatchTransitionInput {
  total: number;
  batchEnd: number;
  contiguousCursor: number;
  failures: number;
  cancelled: boolean;
  aborted: boolean;
}

export type IndexBatchTransition =
  | { kind: 'stopped' }
  | { kind: 'done' }
  | { kind: 'retry'; resumeFrom: number }
  | { kind: 'continue'; resumeFrom: number }
  | { kind: 'incomplete'; resumeFrom: number };

/** Decide the only safe next step after one bounded index batch finishes. */
export function getIndexBatchTransition(
  input: IndexBatchTransitionInput
): IndexBatchTransition {
  const { total, batchEnd, contiguousCursor, failures, cancelled, aborted } = input;

  if (cancelled || aborted) return { kind: 'stopped' };
  if (contiguousCursor >= total) return { kind: 'done' };
  if (failures > 0) return { kind: 'retry', resumeFrom: contiguousCursor };
  if (batchEnd < total) return { kind: 'continue', resumeFrom: batchEnd };
  return { kind: 'incomplete', resumeFrom: contiguousCursor };
}
