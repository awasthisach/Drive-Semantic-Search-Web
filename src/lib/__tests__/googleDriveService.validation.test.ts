import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchGoogleDriveData, listSharedDrives } from '../googleDriveService';

describe('fetchGoogleDriveData validation', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('rejects empty accessToken', async () => {
    await expect(fetchGoogleDriveData('')).rejects.toThrow(/accessToken/);
  });

  it('rejects invalid fileType', async () => {
    await expect(
      fetchGoogleDriveData('tok', 'not-a-type' as any)
    ).rejects.toThrow(/fileType/);
  });

  it('requires driveId when corpus is drive', async () => {
    await expect(fetchGoogleDriveData('tok', 'all', 1, 'drive')).rejects.toThrow(/driveId/);
  });
});

describe('listSharedDrives validation', () => {
  it('rejects empty accessToken', async () => {
    await expect(listSharedDrives('')).rejects.toThrow(/accessToken/);
  });
});
