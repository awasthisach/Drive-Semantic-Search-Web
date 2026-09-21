import { useState, useEffect, useRef } from 'react';
import { DriveFile, VaultFile, SyncStats, FolderItem, AppTab } from '../types';
import { INITIAL_FILES, INITIAL_FOLDERS } from '../lib/driveApi';
import { initAuth } from '../lib/firebaseAuth';
import {
  listSharedDrives,
  DriveFileTypeFilter,
  DriveCorpus,
  SharedDriveInfo,
} from '../lib/googleDriveService';
import { loadVaultFiles } from '../lib/vaultStore';
import { listOfflineMeta } from '../lib/offlineCache';
import { loadDriveMetaSnapshot } from '../lib/driveMetaStore';
import { runDriveSync } from '../lib/syncDrive';

export function useDriveAppState() {
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
  // Keep latest files/folders for initAuth (avoids stale INITIAL_FILES closure)
  const filesRef = useRef(files);
  const foldersRef = useRef(folders);
  filesRef.current = files;
  foldersRef.current = folders;

  const [activeTab, setActiveTab] = useState<AppTab>('dashboard');
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
        const snap = await loadDriveMetaSnapshot();
        if (cancelled || !snap || !snap.files?.length) return;
        setFiles(prev => {
          const driveIds = new Set(snap.files.map(f => f.id));
          const localOnly = prev.filter(f => !f.isGoogleDriveItem && !driveIds.has(f.id));
          return [...snap.files, ...localOnly];
        });
        if (snap.folders?.length) setFolders(snap.folders);
        if (snap.truncated) setDriveTruncated(true);
        setSyncStats(s => ({
          ...s,
          totalSyncedCount: snap.files.length,
          lastSynced: snap.savedAt,
        }));
      } catch (e) {
        console.warn('Drive meta restore skipped:', e);
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
          return { ...f, isOffline: true, contentHash: hashById.get(f.id) || f.contentHash };
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
          const result = await runDriveSync({
            token,
            typeToUse: 'all',
            corpus: savedCorpus === 'drive' && savedDriveId ? 'drive' : savedCorpus === 'allDrives' ? 'allDrives' : 'user',
            driveId: savedDriveId,
            // Use refs so we merge against cached/snapshot state, not mount-time INITIAL_FILES
            currentFiles: filesRef.current,
            currentFolders: foldersRef.current,
          });
          setDriveTruncated(result.truncated);
          setFiles(result.files);
          setFolders(result.folders);
          setSyncStats(s => ({
            ...s,
            status: 'synced',
            totalSyncedCount: result.files.filter(f => f.isGoogleDriveItem).length,
            lastSynced: new Date().toISOString(),
          }));
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

  return {
    files, setFiles, folders, setFolders, vaultFiles, setVaultFiles,
    isGoogleConnected, setIsGoogleConnected, isGoogleLoading, setIsGoogleLoading,
    googleAccessToken, setGoogleAccessToken,
    driveFileTypeFilter, setDriveFileTypeFilter, driveCorpus, setDriveCorpus,
    sharedDriveId, setSharedDriveId, sharedDrives, setSharedDrives,
    driveTruncated, setDriveTruncated, driveNotification, setDriveNotification,
    authErrorModalOpen, setAuthErrorModalOpen, authErrorMessage, setAuthErrorMessage,
    activeTab, setActiveTab, syncStats, setSyncStats,
    previewFile, setPreviewFile, searchMoveTargetFile, setSearchMoveTargetFile,
    verifyBusy, setVerifyBusy, userProfile, setUserProfile,
    showDriveToast,
  };
}

export type DriveAppState = ReturnType<typeof useDriveAppState>;
