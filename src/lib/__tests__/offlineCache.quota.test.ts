import { describe, it, expect } from 'vitest';
import { MAX_CACHE_BYTES, MAX_CACHE_ENTRIES, applyOfflineMetaToDriveFiles } from '../offlineCache';
import { findDuplicates } from '../duplicateEngine';
import type { DriveFile } from '../../types';

describe('offlineCache quotas', () => {
  it('exports positive quota limits', () => {
    expect(MAX_CACHE_BYTES).toBeGreaterThan(1024 * 1024);
    expect(MAX_CACHE_ENTRIES).toBeGreaterThan(10);
  });
});

function makeFile(p: Partial<DriveFile> & { id: string; name: string }): DriveFile {
  return {
    mimeType: 'application/pdf',
    size: 1000,
    modifiedTime: '2024-01-01T00:00:00.000Z',
    createdTime: '2024-01-01T00:00:00.000Z',
    category: 'document',
    isOffline: false,
    isEncrypted: false,
    contentHash: 'gdrive-' + p.id,
    tags: [],
    semanticSummary: p.name,
    starred: false,
    isGoogleDriveItem: true,
    ...p,
  } as DriveFile;
}

describe('duplicate confirmation semantics', () => {
  it('marks size/name groups without sha256 prefix', () => {
    const groups = findDuplicates([
      makeFile({ id: '1', name: 'a.pdf', size: 100 }),
      makeFile({ id: '2', name: 'a.pdf', size: 100 }),
    ]);
    expect(groups[0].hash.startsWith('sha256:')).toBe(false);
  });

  it('marks offline-hash groups with sha256 prefix', () => {
    const groups = findDuplicates([
      makeFile({ id: '1', name: 'x.pdf', contentHash: 'sha256:abc', contentHashModifiedTime: '2024-01-01T00:00:00.000Z' }),
      makeFile({ id: '2', name: 'y.pdf', contentHash: 'sha256:abc', contentHashModifiedTime: '2024-01-01T00:00:00.000Z' }),
    ]);
    expect(groups[0].hash.startsWith('sha256:')).toBe(true);
  });
});

describe('offline SHA revision restoration', () => {
  it('restores a cached SHA only for the matching Drive modifiedTime', () => {
    const file = makeFile({
      id: 'cached', name: 'cached.txt', modifiedTime: '2026-01-01T00:00:00.000Z',
      contentHash: 'sha256:stale', contentHashModifiedTime: '2025-01-01T00:00:00.000Z',
    });
    const meta = {
      id: 'cached', name: 'cached.txt', mimeType: 'text/plain', size: 5, cachedAt: '2026-01-01',
      sha256: 'cached-hash', driveModifiedTime: '2026-01-01T00:00:00.000Z',
    };
    const [restored] = applyOfflineMetaToDriveFiles([file], [meta]);
    expect(restored.contentHash).toBe('sha256:cached-hash');
    expect(restored.contentHashModifiedTime).toBe(file.modifiedTime);
    expect(restored.isOffline).toBe(true);
  });

  it('does not restore an offline hash from a different Drive revision', () => {
    const file = makeFile({ id: 'cached', name: 'cached.txt', modifiedTime: '2026-02-01T00:00:00.000Z' });
    const meta = {
      id: 'cached', name: 'cached.txt', mimeType: 'text/plain', size: 5, cachedAt: '2026-01-01',
      sha256: 'old-hash', driveModifiedTime: '2026-01-01T00:00:00.000Z',
    };
    const [restored] = applyOfflineMetaToDriveFiles([file], [meta]);
    expect(restored.contentHash).not.toMatch(/^sha256:/);
    expect(restored.contentHash).toBe('gdrive-cached');
    expect(restored.contentHashModifiedTime).toBeUndefined();
  });

  it('preserves a valid current-revision hash when offline metadata is stale', () => {
    const file = makeFile({
      id: 'cached', name: 'cached.txt', modifiedTime: '2026-01-01T00:00:00.000Z',
      contentHash: 'sha256:current', contentHashModifiedTime: '2026-01-01T00:00:00.000Z',
    });
    const meta = {
      id: 'cached', name: 'cached.txt', mimeType: 'text/plain', size: 5, cachedAt: '2026-02-01',
      sha256: 'old-hash', driveModifiedTime: '2025-12-01T00:00:00.000Z',
    };
    const [restored] = applyOfflineMetaToDriveFiles([file], [meta]);
    expect(restored.contentHash).toBe('sha256:current');
    expect(restored.contentHashModifiedTime).toBe(file.modifiedTime);
  });
});
