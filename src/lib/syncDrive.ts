import type { DriveFile, FolderItem } from '../types';
import { fetchGoogleDriveData, type DriveCorpus, type DriveFileTypeFilter } from './googleDriveService';
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
}): Promise<{ files: DriveFile[]; folders: FolderItem[]; truncated: boolean; message: string; mode: 'full' | 'incremental' }> {
  const { token, typeToUse, corpus, driveId, currentFiles, currentFolders } = opts;
  const cKey = makeCorpusKey(String(corpus), driveId);

  // Incremental only when filter is "all" and we already have a trusted complete baseline token
  if (typeToUse === 'all') {
    try {
      const pageToken = await loadChangesPageToken(String(corpus), driveId);
      if (pageToken) {
        const { changes, newPageToken } = await listAllDriveChanges(token, pageToken, corpus, driveId);
        const r = applyDriveChanges(currentFiles, currentFolders, changes);
        await saveChangesPageToken(String(corpus), driveId, newPageToken);
        await saveDriveMetaSnapshot(r.files, r.folders, {
          corpus: String(corpus),
          sharedDriveId: driveId,
          truncated: false,
        });
        // Only remove index rows for files Changes API marked deleted/trashed — never global prune here
        if (r.removedIds.length > 0) {
          await removeIndexedDocumentsByIds(r.removedIds);
        }
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

  const driveData = await fetchGoogleDriveData(token, typeToUse, 40, corpus, driveId);
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
    try {
      const startTok = await getChangesStartPageToken(token, corpus, driveId);
      await saveChangesPageToken(String(corpus), driveId, startTok);
    } catch (e) {
      console.warn('startPageToken failed', e);
    }
  } else if (truncated && typeToUse === 'all') {
    // Incomplete baseline must not unlock incremental mode
    try {
      await clearChangesPageToken(String(corpus), driveId);
    } catch {
      /* */
    }
  }

  const truncMsg = truncated ? ' (list capped — more files on Drive; index prune skipped)' : '';
  return {
    files,
    folders,
    truncated,
    mode: 'full',
    message: 'Full sync (' + typeToUse + '): ' + driveData.files.length + ' files' + truncMsg,
  };
}
