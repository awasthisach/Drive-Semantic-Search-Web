import { useRef, useEffect } from 'react';
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
import { saveDriveMetaSnapshot } from '../lib/driveMetaStore';
import type { DriveAppState } from './useDriveAppState';

/** Bounded concurrency for Drive mutations (quota-friendly). */
async function poolMap<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  const queue = items.slice();
  const n = Math.max(1, Math.min(limit, queue.length || 1));
  const workers = Array.from({ length: n }, async () => {
    for (;;) {
      const item = queue.shift();
      if (item === undefined) break;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

export function useDriveHandlersRest(s: DriveAppState) {
  const {
    files, setFiles, folders, setFolders, setVaultFiles,
    isGoogleConnected,
    googleAccessToken, setGoogleAccessToken,
    setIsGoogleLoading,
    setVerifyBusy,
    showDriveToast,
  } = s;

  // Survives re-renders so a new pin can cancel an in-flight pin
  const offlineAbortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    return () => {
      offlineAbortRef.current?.abort();
      offlineAbortRef.current = null;
    };
  }, []);

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
    await poolMap(driveItems, 4, async (f) => {
      try {
        await withDriveAuthRetry(
          async () => (await ensureValidToken()) || googleAccessToken || (await getAccessToken()),
          tok => setGoogleAccessToken(tok),
          tok => deleteGoogleDriveFile(tok, f.id)
        );
        succeeded.push(f.id);
      } catch (err) {
        console.error(err);
        failed.push(f.name);
      }
    });
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
    const driveMoves = toMove.filter(f => f.isGoogleDriveItem);
    const localMoves = toMove.filter(f => !f.isGoogleDriveItem);
    for (const f of localMoves) succeeded.push(f.id);
    await poolMap(driveMoves, 4, async (f) => {
      try {
        await withDriveAuthRetry(
          async () => (await ensureValidToken()) || googleAccessToken || (await getAccessToken()),
          tok => setGoogleAccessToken(tok),
          tok => moveGoogleDriveFile(tok, f.id, targetFolderId || 'root')
        );
        succeeded.push(f.id);
      } catch (err: any) {
        console.error(err);
        showDriveToast('Move failed for ' + f.name + ': ' + (err?.message || 'error'));
      }
    });
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
    offlineAbortRef.current?.abort();
    offlineAbortRef.current = new AbortController();
    const { signal } = offlineAbortRef.current;
    const token = (await ensureValidToken()) || googleAccessToken || (await getAccessToken());
    if (signal.aborted) return;
    if (!token && file.isGoogleDriveItem) {
      showDriveToast('Sign in required to pin Drive file offline');
      return;
    }
    try {
      let blob: Blob;
      let downloadName: string | undefined;
      if (file.isGoogleDriveItem && token) {
        const res = await downloadDriveFileBytes(token, file.id, file.mimeType, { signal });
        if (signal.aborted) return;
        blob = res.blob;
        downloadName = res.downloadName ? file.name + res.downloadName : undefined;
      } else {
        showDriveToast('Cannot pin: no local bytes available');
        return;
      }
      const hash = await sha256Blob(blob);
      if (signal.aborted) return;
      const result = await putOfflineBlob(file.id, blob, {
        name: downloadName || file.name,
        mimeType: blob.type || file.mimeType,
        size: blob.size,
        sha256: hash,
      });
      if (signal.aborted) return;
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
      if (signal.aborted) return;
      console.error(err);
      showDriveToast('Offline pin failed: ' + (err?.message || 'error'));
    }
  };

  const handleVerifyHashes = async (fileIds: string[]) => {
    const targets = files.filter(f => fileIds.includes(f.id) && f.isGoogleDriveItem);
    if (!targets.length) return;

    setVerifyBusy(true);
    showDriveToast('Verifying SHA-256 for ' + targets.length + ' file(s)…');

    // Race-free: accumulate hashes locally, apply once, then persist durable snapshot.
    const hashResults = new Map<string, { contentHash: string; size: number }>();

    try {
      const { ok, failed } = await withDriveAuthRetry(
        async () => (await ensureValidToken()) || googleAccessToken || (await getAccessToken()),
        tok => setGoogleAccessToken(tok),
        tok =>
          verifyFilesHashQueue(tok, targets, {
            onHashed: (id, contentHash, size) => {
              hashResults.set(id, { contentHash, size: size || 0 });
            },
          })
      );

      if (hashResults.size > 0) {
        setFiles(prev =>
          prev.map(f => {
            const r = hashResults.get(f.id);
            return r
              ? { ...f, contentHash: r.contentHash, size: r.size || f.size }
              : f;
          })
        );

        const mergedFiles = files.map(f => {
          const r = hashResults.get(f.id);
          return r
            ? { ...f, contentHash: r.contentHash, size: r.size || f.size }
            : f;
        });

        void saveDriveMetaSnapshot(mergedFiles, folders, {
          corpus: s.driveCorpus,
          sharedDriveId: s.sharedDriveId || undefined,
          truncated: s.driveTruncated,
        }).catch(e => {
          console.warn('[hashVerifier] durable snapshot persist failed', e);
        });
      }

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
