import type { DriveFile, FolderItem } from '../types';
import { fetchGoogleDriveData, type DriveCorpus, type DriveFileTypeFilter } from './googleDriveService';
import { saveDriveMetaSnapshot, saveChangesPageToken, loadChangesPageToken, clearChangesPageToken } from './driveMetaStore';
import { pruneMissingFromIndex } from './contentIndex';
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

  if (typeToUse === 'all') {
    try {
      const pageToken = await loadChangesPageToken(String(corpus), driveId);
      if (pageToken) {
        const { changes, newPageToken } = await listAllDriveChanges(token, pageToken, corpus, driveId);
        const r = applyDriveChanges(currentFiles, currentFolders, changes);
        await saveChangesPageToken(String(corpus), driveId, newPageToken);
        await saveDriveMetaSnapshot(r.files, r.folders, { corpus: String(corpus), sharedDriveId: driveId, truncated: false });
        await pruneMissingFromIndex(new Set(r.files.filter(f => f.isGoogleDriveItem).map(f => f.id)));
        return {
          files: r.files,
          folders: r.folders,
          truncated: false,
          mode: 'incremental',
          message: 'Incremental sync: +' + r.added + ' ~' + r.updated + ' -' + r.removed + (changes.length === 0 ? ' (up to date)' : ''),
        };
      }
    } catch (e) {
      console.warn('Incremental sync failed, falling back to full list', e);
      try { await clearChangesPageToken(String(corpus), driveId); } catch { /* */ }
    }
  }

  const driveData = await fetchGoogleDriveData(token, typeToUse, 40, corpus, driveId);
  const driveIds = new Set(driveData.files.map(f => f.id));
  const files = [...driveData.files, ...currentFiles.filter(f => !driveIds.has(f.id) && !f.isGoogleDriveItem)];
  const driveFolderIds = new Set(driveData.folders.map(fd => fd.id));
  const folders = [...driveData.folders, ...currentFolders.filter(fd => !driveFolderIds.has(fd.id))];

  await saveDriveMetaSnapshot(driveData.files, driveData.folders, {
    corpus: String(corpus), sharedDriveId: driveId, truncated: driveData.truncated,
  });
  await pruneMissingFromIndex(new Set(driveData.files.map(f => f.id)));
  if (typeToUse === 'all') {
    try {
      const startTok = await getChangesStartPageToken(token, corpus, driveId);
      await saveChangesPageToken(String(corpus), driveId, startTok);
    } catch (e) { console.warn('startPageToken failed', e); }
  }
  const truncMsg = driveData.truncated ? ' (list capped — more files on Drive)' : '';
  return {
    files, folders, truncated: Boolean(driveData.truncated), mode: 'full',
    message: 'Full sync (' + typeToUse + '): ' + driveData.files.length + ' files' + truncMsg,
  };
}
