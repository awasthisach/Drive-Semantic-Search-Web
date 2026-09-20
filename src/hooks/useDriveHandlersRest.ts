import { DriveFile, VaultFile, FolderItem } from '../types';
import { getAccessToken, ensureValidToken } from '../lib/firebaseAuth';
import {
  moveGoogleDriveFile,
  createGoogleDriveFolder,
  deleteGoogleDriveFile,
  starGoogleDriveFile,
} from '../lib/googleDriveService';
import { saveVaultFile, removeVaultFile } from '../lib/vaultStore';
import {
  putOfflineBlob,
  removeOfflineBlob,
  downloadDriveFileBytes,
  sha256Blob,
  listOfflineMeta,
} from '../lib/offlineCache';
import { withDriveAuthRetry } from '../lib/driveAuth';
import { verifyFilesHashQueue } from '../lib/hashVerifier';
import { removeIndexedDocument } from '../lib/contentIndex';
import type { DriveAppState } from './useDriveAppState';

export function useDriveHandlersRest(s: DriveAppState) {
  const {
    files, setFiles, folders, setFolders, setVaultFiles,
    isGoogleConnected,
    googleAccessToken, setGoogleAccessToken,
    setIsGoogleLoading,
    setVerifyBusy,
    showDriveToast,
  } = s;

  const handleDeleteFile = async (id: string) => {
    const fileToDelete = files.find(f => f.id === id);
    if (!fileToDelete) return;
    if (fileToDelete.isGoogleDriveItem) {
      try {
        await withDriveAuthRetry(
          async () => (await ensureValidToken()) || googleAccessToken || (await getAccessToken()),
          t => setGoogleAccessToken(t),
          tok => deleteGoogleDriveFile(tok, id)
        );
        setFiles(prev => prev.filter(f => f.id !== id));
        void removeIndexedDocument(id);
        showDriveToast('Moved to Drive trash: "' + fileToDelete.name + '"');
      } catch (err: any) {
        console.error(err);
        showDriveToast('Delete failed: ' + (err?.message || 'error') + ' — file kept');
      }
    } else {
      setFiles(prev => prev.filter(f => f.id !== id));
      void removeIndexedDocument(id);
    }
  };

  const handleRemoveMultipleFiles = async (ids: string[]) => {
    const idSet = new Set(ids);
    const filesToDelete = files.filter(f => idSet.has(f.id));
    const localOnly = filesToDelete.filter(f => !f.isGoogleDriveItem);
    const driveItems = filesToDelete.filter(f => f.isGoogleDriveItem);
    if (localOnly.length) {
      const localIds = new Set(localOnly.map(f => f.id));
      setFiles(prev => prev.filter(f => !localIds.has(f.id)));
      for (const lid of localIds) void removeIndexedDocument(lid);
    }
    if (driveItems.length === 0) return;
    const succeeded: string[] = [];
    const failed: string[] = [];
    for (const f of driveItems) {
      try {
        await withDriveAuthRetry(
          async () => (await ensureValidToken()) || googleAccessToken || (await getAccessToken()),
          t => setGoogleAccessToken(t),
          tok => deleteGoogleDriveFile(tok, f.id)
        );
        succeeded.push(f.id);
      } catch (err) {
        console.error(err);
        failed.push(f.name);
      }
    }
    if (succeeded.length) {
      const ok = new Set(succeeded);
      setFiles(prev => prev.filter(f => !ok.has(f.id)));
      for (const sid of succeeded) void removeIndexedDocument(sid);
    }
    if (failed.length) {
      showDriveToast('Delete partial: ' + failed.length + ' failed');
    } else if (succeeded.length) {
      showDriveToast('Moved ' + succeeded.length + ' file(s) to Drive trash');
    }
  };

  const handleCreateFolder = async (newFolder: FolderItem) => {
    const token = (await ensureValidToken()) || googleAccessToken || (await getAccessToken());
    if (token && isGoogleConnected) {
      try {
        const created = await createGoogleDriveFolder(token, newFolder.name);
        setFolders(prev => [...prev, { ...newFolder, id: created.id }]);
        showDriveToast('Folder "' + newFolder.name + '" created');
      } catch (err: any) {
        console.error(err);
        showDriveToast('Folder create failed: ' + (err?.message || 'error'));
      }
    } else {
      setFolders(prev => [...prev, newFolder]);
    }
  };

  const handleMoveFilesToFolder = async (fileIds: string[], targetFolderId: string | undefined) => {
    const idSet = new Set(fileIds);
    const toMove = files.filter(f => idSet.has(f.id));
    const succeeded: string[] = [];
    for (const f of toMove) {
      if (!f.isGoogleDriveItem) {
        succeeded.push(f.id);
        continue;
      }
      try {
        await withDriveAuthRetry(
          async () => (await ensureValidToken()) || googleAccessToken || (await getAccessToken()),
          t => setGoogleAccessToken(t),
          tok => moveGoogleDriveFile(tok, f.id, targetFolderId || 'root')
        );
        succeeded.push(f.id);
      } catch (err: any) {
        console.error(err);
        showDriveToast('Move failed for ' + f.name + ': ' + (err?.message || 'error'));
      }
    }
    if (succeeded.length) {
      const ok = new Set(succeeded);
      setFiles(prev => prev.map(f => (ok.has(f.id) ? { ...f, folderId: targetFolderId } : f)));
      showDriveToast('Moved ' + succeeded.length + ' file(s)');
    }
  };

  const handleToggleStar = async (id: string) => {
    const file = files.find(f => f.id === id);
    if (!file) return;
    const next = !file.starred;
    setFiles(prev => prev.map(f => (f.id === id ? { ...f, starred: next } : f)));
    if (file.isGoogleDriveItem) {
      try {
        await withDriveAuthRetry(
          async () => (await ensureValidToken()) || googleAccessToken || (await getAccessToken()),
          tok => setGoogleAccessToken(tok),
          tok => starGoogleDriveFile(tok, id, next)
        );
      } catch (err: any) {
        setFiles(prev => prev.map(f => (f.id === id ? { ...f, starred: file.starred } : f)));
        showDriveToast('Star failed: ' + (err?.message || 'error'));
      }
    }
  };

  const handleToggleOffline = async (id: string) => {
    const file = files.find(f => f.id === id);
    if (!file) return;
    if (file.isOffline) {
      try {
        await removeOfflineBlob(id);
        setFiles(prev => prev.map(f => (f.id === id ? { ...f, isOffline: false } : f)));
        showDriveToast('Removed offline pin: ' + file.name);
      } catch (e) {
        console.warn(e);
        showDriveToast('Unpin failed');
      }
      return;
    }
    const token = (await ensureValidToken()) || googleAccessToken || (await getAccessToken());
    if (!token && file.isGoogleDriveItem) {
      showDriveToast('Sign in required to pin Drive file offline');
      return;
    }
    try {
      let blob: Blob;
      let downloadName: string | undefined;
      if (file.isGoogleDriveItem && token) {
        const res = await downloadDriveFileBytes(token, file.id, file.mimeType);
        blob = res.blob;
        downloadName = res.downloadName ? file.name + res.downloadName : undefined;
      } else {
        showDriveToast('Cannot pin: no local bytes available');
        return;
      }
      const hash = await sha256Blob(blob);
      const result = await putOfflineBlob(file.id, blob, {
        name: downloadName || file.name,
        mimeType: blob.type || file.mimeType,
        size: blob.size,
        sha256: hash,
      });
      const offlineIds = new Set((await listOfflineMeta()).map(m => m.id));
      setFiles(prev =>
        prev.map(f => {
          if (f.id === file.id) {
            return { ...f, isOffline: true, contentHash: 'sha256:' + hash, size: blob.size || f.size };
          }
          if (f.isOffline && !offlineIds.has(f.id)) {
            return { ...f, isOffline: false };
          }
          return f;
        })
      );
      if (result?.evictedIds?.length) {
        showDriveToast('Pinned offline (evicted ' + result.evictedIds.length + ' older cache entries)');
      } else {
        showDriveToast('Pinned offline: ' + file.name);
      }
    } catch (err: any) {
      console.error(err);
      showDriveToast('Offline pin failed: ' + (err?.message || 'error'));
    }
  };

  const handleVerifyHashes = async (fileIds: string[]) => {
    const targets = files.filter(f => fileIds.includes(f.id) && f.isGoogleDriveItem);
    if (!targets.length) return;
    setVerifyBusy(true);
    showDriveToast('Verifying SHA-256 for ' + targets.length + ' file(s)…');
    try {
      const { ok, failed } = await withDriveAuthRetry(
        async () => (await ensureValidToken()) || googleAccessToken || (await getAccessToken()),
        tok => setGoogleAccessToken(tok),
        tok =>
          verifyFilesHashQueue(tok, targets, {
            onHashed: (id, contentHash, size) => {
              setFiles(prev =>
                prev.map(f => (f.id === id ? { ...f, contentHash, size: size || f.size } : f))
              );
            },
          })
      );
      showDriveToast('Hash verify done: ' + ok + ' ok, ' + failed + ' failed');
    } catch (e: any) {
      showDriveToast('Hash verify error: ' + (e?.message || 'error'));
    } finally {
      setVerifyBusy(false);
    }
  };

  const handleAddVaultFile = async (vf: VaultFile) => {
    try {
      await saveVaultFile(vf);
      setVaultFiles(prev => [vf, ...prev.filter(x => x.id !== vf.id)]);
    } catch (e) {
      console.warn('Vault save failed:', e);
    }
  };

  const handleDeleteVaultFile = async (id: string) => {
    try {
      await removeVaultFile(id);
      setVaultFiles(prev => prev.filter(v => v.id !== id));
    } catch (e) {
      console.warn('Vault remove failed:', e);
    }
  };

  return {
    handleDeleteFile, handleRemoveMultipleFiles, handleCreateFolder,
    handleMoveFilesToFolder, handleToggleStar, handleToggleOffline,
    handleVerifyHashes, handleAddVaultFile, handleDeleteVaultFile,
  };
}
