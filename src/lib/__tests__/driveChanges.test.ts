import { describe, it, expect, vi, afterEach } from 'vitest';
import { applyDriveChanges, listAllDriveChanges } from '../driveChanges';
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
    expect(r.removedIds).toEqual(['a']);
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

  it('invalidates a verified hash when a file revision changes', () => {
    const previous = {
      ...base('a', 'A'),
      modifiedTime: '2026-01-01T00:00:00.000Z',
      contentHash: 'sha256:verified-old-revision',
      contentHashModifiedTime: '2026-01-01T00:00:00.000Z',
    };
    const result = applyDriveChanges([previous], [], [{
      fileId: 'a', removed: false,
      file: { id: 'a', name: 'A', mimeType: 'text/plain', size: '11', modifiedTime: '2026-02-01T00:00:00.000Z' },
    }]);
    expect(result.files[0].contentHash).not.toMatch(/^sha256:/);
    expect(result.files[0].contentHashModifiedTime).toBeUndefined();
  });

  it('preserves a verified hash only for the same revision', () => {
    const previous = {
      ...base('a', 'A'),
      modifiedTime: '2026-01-01T00:00:00.000Z',
      contentHash: 'sha256:verified-revision',
      contentHashModifiedTime: '2026-01-01T00:00:00.000Z',
    };
    const result = applyDriveChanges([previous], [], [{
      fileId: 'a', removed: false,
      file: { id: 'a', name: 'A', mimeType: 'text/plain', size: '10', modifiedTime: '2026-01-01T00:00:00.000Z' },
    }]);
    expect(result.files[0].contentHash).toBe('sha256:verified-revision');
    expect(result.files[0].contentHashModifiedTime).toBe(previous.modifiedTime);
  });
});

describe('listAllDriveChanges', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('rejects an incomplete drain rather than returning the starting checkpoint', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ changes: [], nextPageToken: 'page-2' }), { status: 200 })));
    await expect(listAllDriveChanges('token', 'page-1', 'user', undefined, 1))
      .rejects.toThrow(/pagination incomplete/i);
  });

  it('returns the new checkpoint after reaching the terminal page', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ changes: [], newStartPageToken: 'page-new' }), { status: 200 })));
    await expect(listAllDriveChanges('token', 'page-1', 'user', undefined, 1))
      .resolves.toEqual({ changes: [], newPageToken: 'page-new' });
  });
});
