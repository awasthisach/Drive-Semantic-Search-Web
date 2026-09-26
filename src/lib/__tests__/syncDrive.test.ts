import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runDriveSync } from '../syncDrive';
import { fetchGoogleDriveData } from '../googleDriveService';
import { saveChangesPageToken, saveDriveMetaSnapshot, loadChangesPageToken, clearChangesPageToken } from '../driveMetaStore';
import { removeIndexedDocumentsByIds, pruneMissingFromIndex } from '../contentIndex';
import { applyDriveChanges, getChangesStartPageToken, listAllDriveChanges } from '../driveChanges';

const order: string[] = [];

vi.mock('../googleDriveService', () => ({ fetchGoogleDriveData: vi.fn() }));
vi.mock('../driveMetaStore', () => ({
  saveDriveMetaSnapshot: vi.fn(async () => { order.push('snapshot'); }),
  saveChangesPageToken: vi.fn(async () => { order.push('checkpoint'); }),
  loadChangesPageToken: vi.fn(async () => null),
  clearChangesPageToken: vi.fn(async () => { order.push('clear-checkpoint'); }),
}));
vi.mock('../contentIndex', () => ({
  pruneMissingFromIndex: vi.fn(async () => 0),
  removeIndexedDocumentsByIds: vi.fn(async () => { order.push('remove-index'); return 1; }),
  makeCorpusKey: vi.fn(() => 'user'),
}));
vi.mock('../driveChanges', () => ({
  getChangesStartPageToken: vi.fn(async () => { order.push('capture-baseline'); return 'baseline'; }),
  listAllDriveChanges: vi.fn(async () => ({ changes: [{ fileId: 'gone', removed: true }], newPageToken: 'next' })),
  applyDriveChanges: vi.fn(() => ({ files: [], folders: [], added: 0, updated: 0, removed: 1, removedIds: ['gone'] })),
}));

beforeEach(() => {
  order.length = 0;
  vi.clearAllMocks();
});

describe('runDriveSync persistence order', () => {
  it('applies index cleanup and snapshot before advancing an incremental checkpoint', async () => {
    vi.mocked(loadChangesPageToken).mockResolvedValue('old');
    await runDriveSync({
      token: 'token', typeToUse: 'all', corpus: 'user', currentFiles: [], currentFolders: [],
    });
    expect(order).toEqual(['remove-index', 'snapshot', 'checkpoint']);
    expect(listAllDriveChanges).toHaveBeenCalledWith('token', 'old', 'user', undefined);
  });

  it('captures a full-sync Changes baseline before listing, then checkpoints after snapshot', async () => {
    vi.mocked(loadChangesPageToken).mockResolvedValue(null);
    vi.mocked(fetchGoogleDriveData).mockImplementation(async () => {
      order.push('full-list');
      return { files: [], folders: [], truncated: false, pagesFetched: 1 } as Awaited<ReturnType<typeof fetchGoogleDriveData>>;
    });
    await runDriveSync({
      token: 'token', typeToUse: 'all', corpus: 'user', currentFiles: [], currentFolders: [],
    });
    expect(order).toEqual(['capture-baseline', 'full-list', 'snapshot', 'checkpoint']);
    expect(getChangesStartPageToken).toHaveBeenCalledWith('token', 'user', undefined);
    expect(pruneMissingFromIndex).toHaveBeenCalled();
    expect(saveDriveMetaSnapshot).toHaveBeenCalled();
    expect(saveChangesPageToken).toHaveBeenCalledWith('user', undefined, 'baseline');
  });

  it('clears a prior complete-corpus checkpoint before a filtered listing', async () => {
    vi.mocked(loadChangesPageToken).mockResolvedValue('old');
    vi.mocked(fetchGoogleDriveData).mockImplementation(async () => {
      order.push('filtered-list');
      return { files: [], folders: [], truncated: false, pagesFetched: 1 } as Awaited<ReturnType<typeof fetchGoogleDriveData>>;
    });
    await runDriveSync({
      token: 'token', typeToUse: 'text/plain' as any, corpus: 'user', currentFiles: [], currentFolders: [],
    });
    expect(order).toEqual(['clear-checkpoint', 'filtered-list', 'snapshot']);
    expect(clearChangesPageToken).toHaveBeenCalledWith('user', undefined);
    expect(getChangesStartPageToken).not.toHaveBeenCalled();
    expect(saveChangesPageToken).not.toHaveBeenCalled();
  });
});
