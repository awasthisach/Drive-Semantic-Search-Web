import { describe, it, expect } from 'vitest';
import { applyDriveChanges } from '../driveChanges';
import type { DriveFile } from '../../types';

const base = (id: string, name: string): DriveFile => ({
  id,
  name,
  mimeType: 'text/plain',
  size: 10,
  modifiedTime: new Date().toISOString(),
  createdTime: new Date().toISOString(),
  category: 'document',
  isGoogleDriveItem: true,
  isOffline: false,
  isEncrypted: false,
  contentHash: 'gdrive-' + id,
  tags: [],
  semanticSummary: name,
  starred: false,
});

describe('applyDriveChanges', () => {
  it('removes trashed files', () => {
    const files = [base('a', 'A'), base('b', 'B')];
    const r = applyDriveChanges(files, [], [{ fileId: 'a', removed: true }]);
    expect(r.files.map(f => f.id)).toEqual(['b']);
    expect(r.removed).toBe(1);
  });

  it('adds new files from change payload', () => {
    const files = [base('a', 'A')];
    const r = applyDriveChanges(files, [], [
      {
        fileId: 'c',
        removed: false,
        file: {
          id: 'c',
          name: 'C',
          mimeType: 'text/plain',
          size: '5',
          modifiedTime: new Date().toISOString(),
        },
      },
    ]);
    expect(r.files.some(f => f.id === 'c')).toBe(true);
    expect(r.added).toBe(1);
  });
});
