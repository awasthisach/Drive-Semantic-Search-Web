import { describe, it, expect } from 'vitest';
import { analyzeSemanticDuplicatesFromVectors, findDuplicates, findSemanticDuplicatesFromVectors } from '../duplicateEngine';
import type { DriveFile } from '../../types';
import type { VectorRecord } from '../vectorIndex';

function makeFile(partial: Partial<DriveFile> & { id: string; name: string }): DriveFile {
  return {
    mimeType: 'application/pdf',
    size: 1000,
    modifiedTime: '2024-01-01T00:00:00.000Z',
    createdTime: '2024-01-01T00:00:00.000Z',
    category: 'document',
    isOffline: false,
    isEncrypted: false,
    contentHash: 'gdrive-' + partial.id,
    tags: [],
    semanticSummary: partial.name,
    starred: false,
    isGoogleDriveItem: true,
    ...partial,
  } as DriveFile;
}

function vector(fileId: string, idx: number, embedding: number[], text = `chunk ${idx}`): VectorRecord {
  return {
    id: fileId + '#' + idx,
    fileId,
    idx,
    text,
    embedding,
    corpusKey: 'user',
    contentHash: 'gdrive-' + fileId,
    embeddingModel: 'gemini-embedding-2',
    embeddingVersion: '3',
    dimension: embedding.length,
    indexedAt: '2024-01-01T00:00:00.000Z',
  };
}

describe('findDuplicates', () => {
  it('groups by size+name when no real hash', () => {
    const files = [
      makeFile({ id: '1', name: 'a.pdf', size: 100 }),
      makeFile({ id: '2', name: 'a.pdf', size: 100 }),
    ];
    const groups = findDuplicates(files);
    expect(groups.length).toBe(1);
    expect(groups[0].fileCount).toBe(2);
    expect(groups[0].verification).toBe('candidate');
  });

  it('prefers sha256 groups', () => {
    const files = [
      makeFile({ id: '1', name: 'x.pdf', contentHash: 'sha256:abc', contentHashModifiedTime: '2024-01-01T00:00:00.000Z' }),
      makeFile({ id: '2', name: 'y.pdf', contentHash: 'sha256:abc', contentHashModifiedTime: '2024-01-01T00:00:00.000Z' }),
    ];
    const groups = findDuplicates(files);
    expect(groups.length).toBe(1);
    expect(groups[0].hash.startsWith('sha256:')).toBe(true);
    expect(groups[0].verification).toBe('sha256');
  });

  it('downgrades legacy or revision-mismatched SHA values to candidates', () => {
    const files = [
      makeFile({ id: '1', name: 'same.pdf', contentHash: 'sha256:old', contentHashModifiedTime: '2023-01-01T00:00:00.000Z' }),
      makeFile({ id: '2', name: 'same.pdf', contentHash: 'sha256:old', contentHashModifiedTime: '2023-01-01T00:00:00.000Z' }),
    ];
    const groups = findDuplicates(files);
    expect(groups).toHaveLength(1);
    expect(groups[0].verification).toBe('candidate');
    expect(groups[0].hash).not.toBe('sha256:old');
  });

  it('returns empty when all unique', () => {
    const files = [
      makeFile({ id: '1', name: 'a.pdf', size: 1 }),
      makeFile({ id: '2', name: 'b.pdf', size: 2 }),
    ];
    expect(findDuplicates(files)).toEqual([]);
  });

  it('does not group unknown size (0) by name alone', () => {
    const files = [
      makeFile({ id: '1', name: 'same.pdf', size: 0 }),
      makeFile({ id: '2', name: 'same.pdf', size: 0 }),
    ];
    expect(findDuplicates(files)).toEqual([]);
  });
});

describe('semantic duplicate review', () => {
  it('groups indexed semantic near-duplicates for review without exact hashes', () => {
    const files = [
      makeFile({ id: '1', name: 'Hindi notes.txt', contentHash: 'gdrive-1' }),
      makeFile({ id: '2', name: 'English notes.txt', contentHash: 'gdrive-2' }),
      makeFile({ id: '3', name: 'Budget.xlsx', contentHash: 'gdrive-3' }),
    ];
    const groups = findSemanticDuplicatesFromVectors(files, [
      vector('1', 0, [1, 0]), vector('2', 0, [0.99, 0.01]), vector('3', 0, [0, 1]),
    ], 0.9);
    expect(groups).toHaveLength(1);
    expect(groups[0].files.map(file => file.id)).toEqual(['1', '2']);
    expect(groups[0].bestPairSimilarity).toBeGreaterThan(0.9);
  });

  it('finds the same content under different names and byte sizes without using metadata as a gate', () => {
    const files = [
      makeFile({ id: 'a', name: 'History - scan.pdf', size: 1_200_000 }),
      makeFile({ id: 'b', name: 'old_archive_002.pdf', size: 2_400_000 }),
    ];
    const rows = [
      vector('a', 0, [1, 0]), vector('a', 1, [0, 1]), vector('a', 2, [0.7, 0.7]),
      vector('b', 0, [0.999, 0.01]), vector('b', 1, [0.01, 0.999]), vector('b', 2, [0.71, 0.70]),
    ];
    const groups = findSemanticDuplicatesFromVectors(files, rows, 0.9);
    expect(groups).toHaveLength(1);
    expect(groups[0].files.map(file => file.id).sort()).toEqual(['a', 'b']);
  });

  it('does not call two same-topic documents duplicates from one shared chunk alone', () => {
    const files = [
      makeFile({ id: 'a', name: 'Physics textbook.pdf' }),
      makeFile({ id: 'b', name: 'Optics textbook.pdf' }),
    ];
    const rows = [
      vector('a', 0, [1, 0]), vector('a', 1, [0, 1]), vector('a', 2, [0, -1]),
      vector('b', 0, [0.999, 0.01]), vector('b', 1, [-1, 0]), vector('b', 2, [-0.7, -0.7]),
    ];
    const analysis = analyzeSemanticDuplicatesFromVectors(files, rows, 0.9);
    expect(analysis.groups).toHaveLength(0);
  });

  it('returns near-threshold pairs separately so a user can request more sampled pages', () => {
    const files = [
      makeFile({ id: 'a', name: 'scan-a.pdf' }),
      makeFile({ id: 'b', name: 'scan-b.pdf' }),
    ];
    const analysis = analyzeSemanticDuplicatesFromVectors(files, [
      vector('a', 0, [1, 0]), vector('b', 0, [0.92, Math.sqrt(1 - 0.92 ** 2)]),
    ], 0.95);
    expect(analysis.groups).toHaveLength(0);
    expect(analysis.uncertainPairs).toHaveLength(1);
    expect(analysis.uncertainPairs[0].similarity).toBeGreaterThanOrEqual(0.9);
    expect(analysis.uncertainPairs[0].similarity).toBeLessThan(0.95);
  });
});
