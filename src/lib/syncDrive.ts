import type { DriveFile, FolderItem } from '../types';
import {
  fetchGoogleDriveData,
  type DriveCorpus,
  type DriveFileTypeFilter,
  type DriveFetchOnProgress,
} from './googleDriveService';
import { saveDriveMetaSnapshot, saveChangesPageToken, loadChangesPageToken, clearChangesPageToken } from './driveMetaStore';
import { pruneMissingFromIndex, removeIndexedDocumentsByIds, makeCorpusKey } from './contentIndex';
import { getChangesStartPageToken, listAllDriveChanges, applyDriveChanges } from './driveChanges';

export async function runDriveSync(opts: {
  token: string;
  typeToUse: DriveFileTypeFilter;
  corpus: DriveCorpus;
  driveId?: string;
  currentFiles: DriveFile[];
  currentFolders: FolderItem[];
  onProgress?: DriveFetchOnProgress;
}): Promise<{ files: DriveFile[]; folders: FolderItem[]; truncated: boolean; message: string; mode: 'full' | 'incremental' }> {
  const { token, typeToUse, corpus, driveId, currentFiles, currentFolders, onProgress } = opts;
  const cKey = makeCorpusKey(String(corpus), driveId);

  // Incremental only when filter is "all" and we already have a trusted complete baseline token
  if (typeToUse === 'all') {
    try {
      const pageToken = await loadChangesPageToken(String(corpus), driveId);
      if (pageToken) {
        const { changes, newPageToken } = await listAllDriveChanges(token, pageToken, corpus, driveId);
        const r = applyDriveChanges(currentFiles, currentFolders, changes);
        // Finish side effects before advancing the checkpoint. If interrupted
        // before the token write, replaying this batch is safe and completes cleanup.
        if (r.removedIds.length > 0) {
          await removeIndexedDocumentsByIds(r.removedIds);
        }
        await saveDriveMetaSnapshot(r.files, r.folders, {
          corpus: String(corpus),
          sharedDriveId: driveId,
          truncated: false,
        });
        await saveChangesPageToken(String(corpus), driveId, newPageToken);
        return {
          files: r.files,
          folders: r.folders,
          truncated: false,
          mode: 'incremental',
          message:
            'Incremental sync: +' +
            r.added +
            ' ~' +
            r.updated +
            ' -' +
            r.removed +
            (changes.length === 0 ? ' (up to date)' : ''),
        };
      }
    } catch (e) {
      console.warn('Incremental sync failed, falling back to full list', e);
      try {
        await clearChangesPageToken(String(corpus), driveId);
      } catch {
        /* */
      }
    }
  }

  // A filtered file-type listing is not a complete corpus snapshot. Invalidate
  // any prior checkpoint before starting it so a crash or later All-files sync
  // cannot apply deltas to a partial in-memory list.
  if (typeToUse !== 'all') {
    await clearChangesPageToken(String(corpus), driveId);
  }

  // Capture the baseline before enumeration so changes made while listing are
  // replayed by the first incremental drain after this complete snapshot.
  let baselineToken: string | null = null;
  if (typeToUse === 'all') {
    try {
      baselineToken = await getChangesStartPageToken(token, corpus, driveId);
    } catch (e) {
      console.warn('startPageToken failed before full list; sync will not seed incremental mode', e);
    }
  }

  // Progressive full list: no artificial page cap; streams batches via onProgress
  const driveData = await fetchGoogleDriveData(
    token,
    typeToUse,
    undefined,
    corpus,
    driveId,
    onProgress
  );
  const driveIds = new Set(driveData.files.map(f => f.id));
  const files = [
    ...driveData.files,
    ...currentFiles.filter(f => !driveIds.has(f.id) && !f.isGoogleDriveItem),
  ];
  const driveFolderIds = new Set(driveData.folders.map(fd => fd.id));
  const folders = [
    ...driveData.folders,
    ...currentFolders.filter(fd => !driveFolderIds.has(fd.id)),
  ];

  const truncated = Boolean(driveData.truncated);
  // Full non-truncated "all" sync is the only safe complete enumeration for this corpus
  const complete = typeToUse === 'all' && !truncated;

  await saveDriveMetaSnapshot(driveData.files, driveData.folders, {
    corpus: String(corpus),
    sharedDriveId: driveId,
    truncated,
  });

  // SAFETY: never prune on truncated or filtered-type syncs
  if (complete) {
    await pruneMissingFromIndex({
      liveFileIds: new Set(driveData.files.map(f => f.id)),
      corpusKey: cKey,
      complete: true,
    });
  } else if (truncated) {
    console.info('[syncDrive] truncated list — skipping content-index prune and Changes baseline');
  } else if (typeToUse !== 'all') {
    console.info('[syncDrive] filtered type sync (' + typeToUse + ') — skipping content-index prune');
  }

  // Only seed Changes API baseline after a complete full enumeration of "all"
  if (complete) {
    if (baselineToken) await saveChangesPageToken(String(corpus), driveId, baselineToken);
  } else if (truncated && typeToUse === 'all') {
    // Incomplete baseline must not unlock incremental mode
    try {
      await clearChangesPageToken(String(corpus), driveId);
    } catch {
      /* */
    }
  }

  const truncMsg = truncated
    ? ' (safety ceiling hit — more files may exist; index prune skipped)'
    : '';
  return {
    files,
    folders,
    truncated,
    mode: 'full',
    message:
      'Full sync (' +
      typeToUse +
      '): ' +
      driveData.files.length +
      ' files, ' +
      driveData.pagesFetched +
      ' pages' +
      truncMsg,
  };
}
