import React, { useState, useEffect } from 'react';
import { Cloud, CheckCircle2, X } from 'lucide-react';
import { DriveFile, VaultFile, SyncStats, FolderItem } from './types';
import { INITIAL_FILES, INITIAL_FOLDERS } from './lib/driveApi';
import { Dashboard } from './components/Dashboard';
import { OfflineIndicator } from './components/OfflineIndicator';
import { MoveToFolderModal } from './components/MoveToFolderModal';
import { AuthErrorModal } from './components/AuthErrorModal';
import { initAuth, googleSignIn, googleSignOut, getAccessToken, ensureValidToken } from './lib/firebaseAuth';
import {
  fetchGoogleDriveData,
  moveGoogleDriveFile,
  createGoogleDriveFolder,
  deleteGoogleDriveFile,
  uploadGoogleDriveFile,
  starGoogleDriveFile,
  listSharedDrives,
  DriveFileTypeFilter,
  DriveCorpus,
  SharedDriveInfo,
} from './lib/googleDriveService';
import { loadVaultFiles, saveVaultFile, removeVaultFile } from './lib/vaultStore';
import {
  putOfflineBlob,
  removeOfflineBlob,
  downloadDriveFileBytes,
  sha256Blob,
  listOfflineMeta,
} from './lib/offlineCache';
import { withDriveAuthRetry } from './lib/driveAuth';
import { verifyFilesHashQueue } from './lib/hashVerifier';

const DeviceStorageScanner = React.lazy(() =>
  import('./components/DeviceStorageScanner').then(m => ({ default: m.DeviceStorageScanner }))
);
const PrivacyVault = React.lazy(() =>
  import('./components/PrivacyVault').then(m => ({ default: m.PrivacyVault }))
);
const DuplicateFinder = React.lazy(() =>
  import('./components/DuplicateFinder').then(m => ({ default: m.DuplicateFinder }))
);
const SemanticSearch = React.lazy(() =>
  import('./components/SemanticSearch').then(m => ({ default: m.SemanticSearch }))
);
const OfflineFilesList = React.lazy(() =>
  import('./components/OfflineFilesList').then(m => ({ default: m.OfflineFilesList }))
);
const FilePreviewModal = React.lazy(() =>
  import('./components/FilePreviewModal').then(m => ({ default: m.FilePreviewModal }))
);

const TabLoadingFallback = () => (
  <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-8 space-y-4 animate-pulse">
    <div className="h-6 w-1/3 bg-zinc-200 dark:bg-zinc-800 rounded-lg" />
    <div className="h-20 w-full bg-zinc-100 dark:bg-zinc-800/60 rounded-xl" />
  </div>
);

export default function App() {
  const [files, setFiles] = useState<DriveFile[]>(INITIAL_FILES);
  const [folders, setFolders] = useState<FolderItem[]>(INITIAL_FOLDERS);
  const [vaultFiles, setVaultFiles] = useState<VaultFile[]>([]);
  const [isGoogleConnected, setIsGoogleConnected] = useState(false);
  const [isGoogleLoading, setIsGoogleLoading] = useState(false);
  const [googleAccessToken, setGoogleAccessToken] = useState<string | null>(null);
  const [driveFileTypeFilter, setDriveFileTypeFilter] = useState<DriveFileTypeFilter>('all');
  const [driveCorpus, setDriveCorpus] = useState<DriveCorpus>('user');
  const [sharedDriveId, setSharedDriveId] = useState<string>('');
  const [sharedDrives, setSharedDrives] = useState<SharedDriveInfo[]>([]);
  const [driveTruncated, setDriveTruncated] = useState(false);
  const [driveNotification, setDriveNotification] = useState<string | null>(null);
  const [authErrorModalOpen, setAuthErrorModalOpen] = useState(false);
  const [authErrorMessage, setAuthErrorMessage] = useState('');
  const [activeTab, setActiveTab] = useState<'dashboard' | 'storage_scanner' | 'vault' | 'duplicates' | 'search' | 'offline'>('dashboard');
  const [syncStats, setSyncStats] = useState<SyncStats>({
    status: 'synced', lastSynced: new Date().toISOString(), pendingCount: 0,
    totalSyncedCount: INITIAL_FILES.length, bandwidthUsage: '142 KB/s', networkOnline: true,
  });
  const [previewFile, setPreviewFile] = useState<DriveFile | null>(null);
  const [searchMoveTargetFile, setSearchMoveTargetFile] = useState<DriveFile | null>(null);
  const [verifyBusy, setVerifyBusy] = useState(false);
  const [userProfile, setUserProfile] = useState({ name: 'User', email: '', avatar: '', isConnected: false });

  const showDriveToast = (msg: string) => {
    setDriveNotification(msg);
    setTimeout(() => setDriveNotification(null), 5000);
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const stored = await loadVaultFiles();
        if (!cancelled && stored.length) setVaultFiles(stored);
      } catch (e) {
        console.warn('Vault restore skipped:', e);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const metas = await listOfflineMeta();
        if (cancelled || !metas.length) return;
        const offlineIds = new Set(metas.map(m => m.id));
        const hashById = new Map(metas.filter(m => m.sha256).map(m => [m.id, 'sha256:' + m.sha256!]));
        setFiles(prev => prev.map(f => {
          if (!offlineIds.has(f.id)) return f;
          return {
            ...f,
            isOffline: true,
            contentHash: hashById.get(f.id) || f.contentHash,
          };
        }));
      } catch (e) {
        console.warn('Offline restore skipped:', e);
      }
    })();
    return () => { cancelled = true; };
  }, [isGoogleConnected, files.length]);

  useEffect(() => {
    const unsubscribe = initAuth(
      async (user, token) => {
        setIsGoogleConnected(true);
        setGoogleAccessToken(token);
        setUserProfile({
          name: user.displayName || 'Google Drive User',
          email: user.email || '',
          avatar: user.photoURL || '',
          isConnected: true,
        });
        try {
          setIsGoogleLoading(true);
          try {
            const drives = await listSharedDrives(token);
            setSharedDrives(drives);
          } catch (e) {
            console.warn('Shared drives list skipped:', e);
            setSharedDrives([]);
          }
          const savedCorpus = (sessionStorage.getItem('drive_corpus') as DriveCorpus) || 'user';
          const savedDriveId = sessionStorage.getItem('drive_shared_id') || undefined;
          setDriveCorpus(savedCorpus);
          if (savedDriveId) setSharedDriveId(savedDriveId);
          const driveData = await fetchGoogleDriveData(
            token,
            'all',
            20,
            savedCorpus === 'drive' && savedDriveId ? 'drive' : savedCorpus === 'allDrives' ? 'allDrives' : 'user',
            savedDriveId
          );
          setDriveTruncated(Boolean(driveData.truncated));
          if (driveData.files.length > 0 || driveData.folders.length > 0) {
            setFiles(prev => {
              const driveIds = new Set(driveData.files.map(f => f.id));
              const remainingLocal = prev.filter(f => !driveIds.has(f.id) && !f.isGoogleDriveItem);
              return [...driveData.files, ...remainingLocal];
            });
            setFolders(prev => {
              const driveFolderIds = new Set(driveData.folders.map(fd => fd.id));
              const remainingLocalFolders = prev.filter(fd => !driveFolderIds.has(fd.id));
              return [...driveData.folders, ...remainingLocalFolders];
            });
            setSyncStats(s => ({ ...s, status: 'synced', totalSyncedCount: driveData.files.length, lastSynced: new Date().toISOString() }));
          }
        } catch (err) {
          console.warn('Silent Google Drive initial sync skipped:', err);
        } finally {
          setIsGoogleLoading(false);
        }
      },
      () => {
        setIsGoogleConnected(false);
        setGoogleAccessToken(null);
      }
    );
    return () => unsubscribe();
  }, []);

  const handleUploadFile = (newFile: DriveFile) => setFiles(prev => [newFile, ...prev]);

  const handleUploadToDrive = async (file: File) => {
    const token = (await ensureValidToken()) || googleAccessToken || (await getAccessToken());
    if (!token) {
      showDriveToast('Sign in required to upload to Google Drive');
      return;
    }
    setGoogleAccessToken(token);
    try {
      setIsGoogleLoading(true);
      const uploaded = await uploadGoogleDriveFile(token, file);
      setFiles(prev => [uploaded, ...prev]);
      setSyncStats(s => ({
        ...s,
        totalSyncedCount: s.totalSyncedCount + 1,
        lastSynced: new Date().toISOString(),
      }));
      showDriveToast('Uploaded to Drive: "' + uploaded.name + '"');
    } catch (err: any) {
      console.error(err);
      showDriveToast('Upload failed: ' + (err?.message || 'error'));
    } finally {
      setIsGoogleLoading(false);
    }
  };

  const handleConnectDemoDrive = () => {
    setIsGoogleConnected(true);
    setUserProfile(p => ({ ...p, name: 'Demo Drive', isConnected: true }));
    setFiles(INITIAL_FILES);
    setFolders(INITIAL_FOLDERS);
    showDriveToast('Demo Google Drive Connected');
  };

  const handleGoogleSignIn = async () => {
    try {
      setIsGoogleLoading(true);
      const result = await googleSignIn();
      if (result) {
        setGoogleAccessToken(result.accessToken);
        setIsGoogleConnected(true);
        try {
          const drives = await listSharedDrives(result.accessToken);
          setSharedDrives(drives);
        } catch (e) {
          console.warn('Shared drives list skipped:', e);
          setSharedDrives([]);
        }
        setUserProfile({
          name: result.user.displayName || 'Google Drive User',
          email: result.user.email || '',
          avatar: result.user.photoURL || '',
          isConnected: true,
        });
        try {
          const driveData = await fetchGoogleDriveData(result.accessToken, driveFileTypeFilter, 20, driveCorpus, sharedDriveId || undefined);
          setDriveTruncated(Boolean(driveData.truncated));
          if (driveData.files.length > 0 || driveData.folders.length > 0) {
            setFiles(prev => {
              const driveIds = new Set(driveData.files.map(f => f.id));
              const remaining = prev.filter(f => !driveIds.has(f.id) && !f.isGoogleDriveItem);
              return [...driveData.files, ...remaining];
            });
            setFolders(prev => {
              const driveFolderIds = new Set(driveData.folders.map(fd => fd.id));
              const remaining = prev.filter(fd => !driveFolderIds.has(fd.id));
              return [...driveData.folders, ...remaining];
            });
            setSyncStats(s => ({ ...s, status: 'synced', totalSyncedCount: driveData.files.length, lastSynced: new Date().toISOString() }));
            showDriveToast('Google Drive connected! ' + driveData.files.length + ' files loaded.');
          } else {
            showDriveToast('Google Drive connected! (No files found)');
          }
        } catch (e: any) {
          showDriveToast('Connected but sync issue: ' + (e?.message || 'retry Sync Now'));
        }
      } else {
        showDriveToast('Google Sign-In cancelled.');
      }
    } catch (err: any) {
      const message = err?.message || 'Unable to connect to Google Drive';
      if (message.includes('popup-closed') || message.includes('cancelled')) {
        showDriveToast('Sign-In cancelled.');
      } else {
        setAuthErrorMessage(message);
        setAuthErrorModalOpen(true);
      }
    } finally {
      setIsGoogleLoading(false);
    }
  };

  const handleGoogleSignOut = async () => {
    try {
      await googleSignOut({ revoke: true });
      setIsGoogleConnected(false);
      setGoogleAccessToken(null);
      setDriveTruncated(false);
      setSharedDrives([]);
      setDriveCorpus('user');
      setSharedDriveId('');
      setUserProfile(p => ({ ...p, isConnected: false, email: '' }));
      setFiles(INITIAL_FILES);
      setFolders(INITIAL_FOLDERS);
      showDriveToast('Signed out and revoked Drive access');
    } catch (err) {
      console.error('Sign-out error:', err);
    }
  };

  const handleSyncGoogleDrive = async (
    fileType?: DriveFileTypeFilter,
    corpusOverride?: DriveCorpus,
    driveIdOverride?: string
  ) => {
    let token = (await ensureValidToken()) || googleAccessToken || (await getAccessToken());
    if (!token) {
      handleGoogleSignIn();
      return;
    }
    setGoogleAccessToken(token);
    const typeToUse = fileType || driveFileTypeFilter;
    const corpus = corpusOverride ?? driveCorpus;
    const dId = driveIdOverride !== undefined ? driveIdOverride : sharedDriveId;

    const runFetch = async (tok: string) => {
      const driveData = await fetchGoogleDriveData(tok, typeToUse, 20, corpus, dId || undefined);
      setDriveTruncated(Boolean(driveData.truncated));
      setFiles(prev => {
        const driveIds = new Set(driveData.files.map(f => f.id));
        const remaining = prev.filter(f => !driveIds.has(f.id) && !f.isGoogleDriveItem);
        return [...driveData.files, ...remaining];
      });
      setFolders(prev => {
        const driveFolderIds = new Set(driveData.folders.map(fd => fd.id));
        const remaining = prev.filter(fd => !driveFolderIds.has(fd.id));
        return [...driveData.folders, ...remaining];
      });
      setSyncStats(s => ({ ...s, status: 'synced', totalSyncedCount: driveData.files.length, lastSynced: new Date().toISOString() }));
      const truncMsg = driveData.truncated ? ' (list capped — more files on Drive)' : '';
      showDriveToast('Synced (' + typeToUse + '): ' + driveData.files.length + ' files' + truncMsg);
    };

    try {
      setIsGoogleLoading(true);
      if (fileType) setDriveFileTypeFilter(fileType);
      await runFetch(token);
    } catch (err: any) {
      const msg = err?.message || 'Error';
      console.error('Sync failed:', msg);
      if (String(msg).includes('401') || /invalid|auth|login|unauth/i.test(String(msg))) {
        const refreshed = await ensureValidToken();
        if (refreshed) {
          setGoogleAccessToken(refreshed);
          try {
            await runFetch(refreshed);
            showDriveToast('Session refreshed — sync completed');
          } catch (retryErr: any) {
            showDriveToast('Sync failed after refresh: ' + (retryErr?.message || 'error'));
          }
        } else {
          showDriveToast('Session expired — Sign in again');
          setGoogleAccessToken(null);
          setIsGoogleConnected(false);
        }
      } else {
        showDriveToast('Sync failed: ' + msg);
      }
    } finally {
      setIsGoogleLoading(false);
    }
  };

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
        showDriveToast('Moved to Drive trash: "' + fileToDelete.name + '"');
      } catch (err: any) {
        console.error(err);
        showDriveToast('Delete failed: ' + (err?.message || 'error') + ' — file kept');
      }
    } else {
      setFiles(prev => prev.filter(f => f.id !== id));
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
    const snapshot = files.filter(f => idSet.has(f.id));
    const localIds = new Set(snapshot.filter(f => !f.isGoogleDriveItem).map(f => f.id));
    if (localIds.size) {
      setFiles(prev => prev.map(f => (localIds.has(f.id) ? { ...f, folderId: targetFolderId } : f)));
    }
    const driveItems = snapshot.filter(f => f.isGoogleDriveItem);
    if (!driveItems.length) return;
    const token = (await ensureValidToken()) || googleAccessToken || (await getAccessToken());
    if (!token) {
      showDriveToast('Sign in required to move Drive files');
      return;
    }
    const succeeded: string[] = [];
    for (const f of driveItems) {
      try {
        await moveGoogleDriveFile(token, f.id, targetFolderId || 'root');
        succeeded.push(f.id);
      } catch (err: any) {
        console.error(err);
        showDriveToast('Move failed for ' + f.name);
      }
    }
    if (succeeded.length) {
      const ok = new Set(succeeded);
      setFiles(prev => prev.map(f => (ok.has(f.id) ? { ...f, folderId: targetFolderId } : f)));
    }
  };

  const handleToggleStar = async (id: string) => {
    const file = files.find(f => f.id === id);
    if (!file) return;
    const next = !file.starred;
    setFiles(prev => prev.map(f => (f.id === id ? { ...f, starred: next } : f)));
    if (file.isGoogleDriveItem) {
      const token = (await ensureValidToken()) || googleAccessToken || (await getAccessToken());
      if (!token) {
        setFiles(prev => prev.map(f => (f.id === id ? { ...f, starred: file.starred } : f)));
        showDriveToast('Sign in required to star on Drive');
        return;
      }
      try {
        await starGoogleDriveFile(token, id, next);
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
        showDriveToast('Unpinned from offline cache');
      } catch (e: any) {
        showDriveToast('Unpin failed — still marked offline: ' + (e?.message || 'error'));
      }
      return;
    }

    if (file.isGoogleDriveItem) {
      const token = (await ensureValidToken()) || googleAccessToken || (await getAccessToken());
      if (!token) {
        showDriveToast('Sign in required to cache Drive files offline');
        return;
      }
      try {
        setIsGoogleLoading(true);
        const { blob, downloadName } = await downloadDriveFileBytes(token, file.id, file.mimeType);
        let sha: string | undefined;
        try {
          sha = await sha256Blob(blob);
        } catch { /* optional */ }
        const storeName = downloadName
          ? file.name.replace(/\.[^.]+$/, '') + downloadName
          : file.name;
        const isExport = Boolean(downloadName) || (file.mimeType || '').startsWith('application/vnd.google-apps.');
        const { evictedIds } = await putOfflineBlob(id, blob, {
          name: storeName,
          mimeType: blob.type || file.mimeType,
          size: blob.size || file.size,
          sha256: sha,
        });
        const offlineMeta = await listOfflineMeta();
        const offlineIds = new Set(offlineMeta.map(m => m.id));
        const hashById = new Map(
          offlineMeta.filter(m => m.sha256).map(m => [m.id, 'sha256:' + m.sha256!])
        );
        setFiles(prev => prev.map(f => {
          if (f.id === id) {
            return {
              ...f,
              isOffline: true,
              contentHash: sha ? ('sha256:' + sha) : f.contentHash,
              size: blob.size || f.size,
            };
          }
          if (evictedIds.includes(f.id) || (f.isOffline && !offlineIds.has(f.id))) {
            return { ...f, isOffline: false };
          }
          if (offlineIds.has(f.id) && hashById.has(f.id)) {
            return { ...f, isOffline: true, contentHash: hashById.get(f.id) || f.contentHash };
          }
          return f;
        }));
        const hashLabel = sha
          ? (isExport ? ' (SHA-256 of offline export)' : ' (SHA-256)')
          : '';
        const evictMsg = evictedIds.length
          ? ' · Evicted ' + evictedIds.length + ' older pin(s) under cache quota'
          : '';
        showDriveToast('Pinned offline: "' + storeName + '"' + hashLabel + evictMsg);
      } catch (err: any) {
        console.error(err);
        showDriveToast('Offline pin failed: ' + (err?.message || 'error'));
      } finally {
        setIsGoogleLoading(false);
      }
      return;
    }

    setFiles(prev => prev.map(f => (f.id === id ? { ...f, isOffline: true } : f)));
    showDriveToast('Marked offline (local index only — no file bytes)');
  };

  const handleVerifyHashes = async (fileIds: string[]) => {
    const token = (await ensureValidToken()) || googleAccessToken || (await getAccessToken());
    if (!token) {
      showDriveToast('Sign in required to verify file hashes');
      return;
    }
    setGoogleAccessToken(token);
    const targets = files.filter(f => fileIds.includes(f.id) && f.isGoogleDriveItem);
    if (!targets.length) return;
    setVerifyBusy(true);
    showDriveToast('Verifying SHA-256 for ' + targets.length + ' file(s)…');
    try {
      const { ok, failed } = await verifyFilesHashQueue(token, targets, {
        onHashed: (id, contentHash, size) => {
          setFiles(prev => prev.map(f => (f.id === id ? { ...f, contentHash, size: size || f.size } : f)));
        },
      });
      showDriveToast('Hash verify done: ' + ok + ' ok, ' + failed + ' failed');
    } catch (e: any) {
      showDriveToast('Hash verify error: ' + (e?.message || 'error'));
    } finally {
      setVerifyBusy(false);
    }
  };

  const handleAddVaultFile = async (file: VaultFile) => {
    setVaultFiles(prev => [file, ...prev]);
    try {
      await saveVaultFile(file);
    } catch (e) {
      console.warn('Vault persist failed:', e);
      showDriveToast('Note encrypted but IndexedDB save failed');
    }
  };

  const handleDeleteVaultFile = async (id: string) => {
    setVaultFiles(prev => prev.filter(f => f.id !== id));
    try {
      await removeVaultFile(id);
    } catch (e) {
      console.warn('Vault remove failed:', e);
    }
  };

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100">
      <header className="sticky top-0 z-40 border-b border-zinc-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/90 backdrop-blur px-4 py-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Cloud className="w-5 h-5 text-blue-600" />
          <span className="font-bold text-sm">Drive Semantic Search</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-semibold px-2 py-1 rounded-full border border-zinc-200 dark:border-zinc-700">{syncStats.status}</span>
          {isGoogleConnected ? (
            <button type="button" onClick={handleGoogleSignOut} className="text-xs px-2 py-1 rounded-lg border border-zinc-200 dark:border-zinc-700">Sign out</button>
          ) : null}
        </div>
      </header>

      <nav className="flex gap-1 px-3 py-2 overflow-x-auto border-b border-zinc-200 dark:border-zinc-800 text-xs font-semibold">
        {(['dashboard', 'search', 'duplicates', 'vault', 'storage_scanner', 'offline'] as const).map(id => (
          <button key={id} type="button" onClick={() => setActiveTab(id)}
            className={`px-3 py-1.5 rounded-lg whitespace-nowrap ${activeTab === id ? 'bg-blue-600 text-white' : 'bg-zinc-100 dark:bg-zinc-800'}`}>
            {id === 'storage_scanner' ? 'Storage' : id.charAt(0).toUpperCase() + id.slice(1)}
          </button>
        ))}
      </nav>

      <main className="p-4 max-w-5xl mx-auto">
        {activeTab === 'dashboard' && (
          <Dashboard
            files={files} folders={folders} vaultFiles={vaultFiles}
            onUploadFile={handleUploadFile} onUploadToDrive={handleUploadToDrive} onDeleteFile={handleDeleteFile}
            onDeleteMultipleFiles={handleRemoveMultipleFiles} onMoveFilesToFolder={handleMoveFilesToFolder}
            onCreateFolder={handleCreateFolder} onToggleStar={handleToggleStar} onToggleOffline={handleToggleOffline}
            onSelectTab={tab => setActiveTab(tab as any)} onSelectPreviewFile={setPreviewFile}
            isGoogleConnected={isGoogleConnected} isGoogleLoading={isGoogleLoading}
            googleUserEmail={userProfile.email}
            onConnectGoogleDrive={handleGoogleSignIn} onConnectDemoDrive={handleConnectDemoDrive}
            onSyncGoogleDrive={handleSyncGoogleDrive}
            driveTruncated={driveTruncated}
            driveFileTypeFilter={driveFileTypeFilter}
            driveCorpus={driveCorpus}
            sharedDriveId={sharedDriveId}
            sharedDrives={sharedDrives}
            onDriveCorpusChange={(c, id) => {
              setDriveCorpus(c);
              setSharedDriveId(id || '');
              try {
                sessionStorage.setItem('drive_corpus', c);
                if (id) sessionStorage.setItem('drive_shared_id', id);
                else sessionStorage.removeItem('drive_shared_id');
              } catch { /* ignore */ }
              handleSyncGoogleDrive(driveFileTypeFilter, c, id || '');
            }}
            onDriveFileTypeChange={t => { setDriveFileTypeFilter(t); handleSyncGoogleDrive(t); }}
          />
        )}
        {activeTab === 'search' && (
          <React.Suspense fallback={<TabLoadingFallback />}>
            <SemanticSearch
              files={files}
              folders={folders}
              onSelectFile={setPreviewFile}
              onMoveFile={f => setSearchMoveTargetFile(f)}
              accessToken={googleAccessToken}
              onRequestToken={async () => (await ensureValidToken()) || googleAccessToken || (await getAccessToken())}
            />
          </React.Suspense>
        )}
        {activeTab === 'duplicates' && (
          <React.Suspense fallback={<TabLoadingFallback />}>
            <DuplicateFinder
              files={files}
              onRemoveFiles={handleRemoveMultipleFiles}
              onVerifyHashes={handleVerifyHashes}
              verifyBusy={verifyBusy}
            />
          </React.Suspense>
        )}
        {activeTab === 'vault' && (
          <React.Suspense fallback={<TabLoadingFallback />}>
            <PrivacyVault vaultFiles={vaultFiles} onAddVaultFile={handleAddVaultFile} onDeleteVaultFile={handleDeleteVaultFile} />
          </React.Suspense>
        )}
        {activeTab === 'storage_scanner' && (
          <React.Suspense fallback={<TabLoadingFallback />}>
            <DeviceStorageScanner onImportToDrive={handleUploadFile} onImportToVault={handleAddVaultFile} onSelectPreviewFile={setPreviewFile} />
          </React.Suspense>
        )}
        {activeTab === 'offline' && (
          <React.Suspense fallback={<TabLoadingFallback />}>
            <OfflineFilesList files={files} onToggleOffline={handleToggleOffline} onSelectFile={setPreviewFile} />
          </React.Suspense>
        )}
      </main>

      <OfflineIndicator />
      <AuthErrorModal isOpen={authErrorModalOpen} onClose={() => setAuthErrorModalOpen(false)}
        errorMessage={authErrorMessage} onConnectDemoDrive={handleConnectDemoDrive}
        onRetrySignIn={handleGoogleSignIn} isLoading={isGoogleLoading} />

      {driveNotification && (
        <div className="fixed bottom-6 right-6 z-[99999] flex items-center gap-2.5 px-4 py-3 rounded-2xl bg-zinc-900 text-zinc-100 shadow-2xl text-xs font-semibold">
          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
          <span>{driveNotification}</span>
          <button type="button" onClick={() => setDriveNotification(null)} className="ml-2 text-zinc-400"><X className="w-3.5 h-3.5" /></button>
        </div>
      )}
      {previewFile && (
        <React.Suspense fallback={null}>
          <FilePreviewModal file={previewFile} onClose={() => setPreviewFile(null)} onToggleOffline={handleToggleOffline} />
        </React.Suspense>
      )}
      {searchMoveTargetFile && (
        <MoveToFolderModal
          isOpen={!!searchMoveTargetFile}
          onClose={() => setSearchMoveTargetFile(null)}
          selectedFiles={[searchMoveTargetFile]}
          folders={folders}
          allFiles={files}
          onConfirmMove={folderId => {
            handleMoveFilesToFolder([searchMoveTargetFile.id], folderId);
            setSearchMoveTargetFile(null);
          }}
          onCreateFolder={handleCreateFolder}
        />
      )}
    </div>
  );
}
