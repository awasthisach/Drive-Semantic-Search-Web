import { describe, it, expect } from 'vitest';
import { findDuplicates } from '../duplicateEngine';
import type { DriveFile } from '../../types';

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

describe('findDuplicates', () => {
  it('groups by size+name when no real hash', () => {
    const files = [
      makeFile({ id: '1', name: 'a.pdf', size: 100 }),
      makeFile({ id: '2', name: 'a.pdf', size: 100 }),
    ];
    const groups = findDuplicates(files);
    expect(groups.length).toBe(1);
    expect(groups[0].fileCount).toBe(2);
  });

  it('prefers sha256 groups', () => {
    const files = [
      makeFile({ id: '1', name: 'x.pdf', contentHash: 'sha256:abc' }),
      makeFile({ id: '2', name: 'y.pdf', contentHash: 'sha256:abc' }),
    ];
    const groups = findDuplicates(files);
    expect(groups.length).toBe(1);
    expect(groups[0].hash.startsWith('sha256:')).toBe(true);
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
