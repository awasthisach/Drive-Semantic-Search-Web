import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadDriveFileBytes, sha256Blob } from '../offlineCache';
import { hashDriveFile } from '../hashVerifier';
import type { DriveFile } from '../../types';

vi.mock('../offlineCache', () => ({
  downloadDriveFileBytes: vi.fn(),
  sha256Blob: vi.fn(),
}));

afterEach(() => vi.unstubAllGlobals());

const file: DriveFile = {
  id: 'drive-file', name: 'report.txt', mimeType: 'text/plain', size: 5,
  modifiedTime: '2026-01-01T00:00:00.000Z', createdTime: '2025-01-01T00:00:00.000Z',
  category: 'document', isGoogleDriveItem: true, isOffline: false, isEncrypted: false,
  contentHash: 'gdrive-drive-file', tags: [], semanticSummary: 'report',
};

describe('hashDriveFile revision validation', () => {
  it('returns a SHA stamped with the matching Drive revision', async () => {
    vi.mocked(downloadDriveFileBytes).mockResolvedValue({ blob: new Blob(['bytes']) });
    vi.mocked(sha256Blob).mockResolvedValue('verified-hash');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ modifiedTime: file.modifiedTime }), { status: 200 })));
    await expect(hashDriveFile('token', file)).resolves.toEqual({
      sha256: 'verified-hash', size: 5, modifiedTime: file.modifiedTime,
    });
  });

  it('rejects if the Drive revision changed during the download/hash interval', async () => {
    vi.mocked(downloadDriveFileBytes).mockResolvedValue({ blob: new Blob(['old bytes']) });
    vi.mocked(sha256Blob).mockResolvedValue('stale-hash');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ modifiedTime: '2026-02-01T00:00:00.000Z' }), { status: 200 })));
    await expect(hashDriveFile('token', file)).rejects.toThrow(/changed during SHA-256 verification/i);
  });
});
