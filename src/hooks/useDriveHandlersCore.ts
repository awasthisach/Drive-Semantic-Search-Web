import { useRef } from 'react';
import { DriveFile, VaultFile, FolderItem } from '../types';
import { googleSignIn, googleSignOut, getAccessToken, ensureValidToken } from '../lib/firebaseAuth';
import {
  moveGoogleDriveFile,
  createGoogleDriveFolder,
  deleteGoogleDriveFile,
  uploadGoogleDriveFile,
  starGoogleDriveFile,
  listSharedDrives,
  DriveFileTypeFilter,
  DriveCorpus,
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
import { runDriveSync } from '../lib/syncDrive';
import { removeIndexedDocument } from '../lib/contentIndex';
import type { DriveAppState } from './useDriveAppState';
import { INITIAL_FILES, INITIAL_FOLDERS } from '../lib/driveApi';

export function useDriveHandlersCore(s: DriveAppState) {
  const {
    files, setFiles, folders, setFolders, vaultFiles, setVaultFiles,
    isGoogleConnected, setIsGoogleConnected, isGoogleLoading, setIsGoogleLoading,
    googleAccessToken, setGoogleAccessToken,
    driveFileTypeFilter, setDriveFileTypeFilter, driveCorpus, setDriveCorpus,
    sharedDriveId, setSharedDriveId, sharedDrives, setSharedDrives,
    setDriveTruncated,
    setAuthErrorModalOpen, setAuthErrorMessage,
    setSyncStats, setUserProfile, setVerifyBusy,
    showDriveToast,
  } = s;

  const syncInFlightRef = useRef(false);

  const handleUploadFile = (newFile: DriveFile) => setFiles(prev => [newFile, ...prev]);

  const handleUploadToDrive = async (file: File) => {
    try {
      setIsGoogleLoading(true);
      const uploaded = await withDriveAuthRetry(
        async () => (await ensureValidToken()) || googleAccessToken || (await getAccessToken()),
        tok => setGoogleAccessToken(tok),
        tok => uploadGoogleDriveFile(tok, file)
      );
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
    setGoogleAccessToken('demo-token');
    setFiles(INITIAL_FILES);
    setFolders(INITIAL_FOLDERS);
    setSyncStats(s => ({
      ...s,
      status: 'synced',
      totalSyncedCount: INITIAL_FILES.length,
      lastSynced: new Date().toISOString(),
    }));
    showDriveToast('Demo Drive loaded');
  };

  const handleGoogleSignIn = async () => {
    try {
      setIsGoogleLoading(true);
      const result = await googleSignIn();
      setIsGoogleConnected(true);
      setGoogleAccessToken(result.accessToken);
      setUserProfile(result.user);
      try {
        const drives = await listSharedDrives(result.accessToken);
        setSharedDrives(drives);
      } catch (e) {
        console.warn('listSharedDrives', e);
      }
      const syncResult = await runDriveSync({
        token: result.accessToken,
        typeToUse: driveFileTypeFilter,
        corpus: driveCorpus,
        driveId: sharedDriveId || undefined,
        currentFiles: [],
        currentFolders: [],
      });
      setDriveTruncated(syncResult.truncated);
      setFiles(syncResult.files);
      setFolders(syncResult.folders);
      setSyncStats(s => ({
        ...s,
        status: 'synced',
        totalSyncedCount: syncResult.files.filter(f => f.isGoogleDriveItem).length,
        lastSynced: new Date().toISOString(),
      }));
      showDriveToast(syncResult.message || 'Signed in and synced');
    } catch (err: any) {
      console.error(err);
      setAuthErrorMessage(err?.message || 'Sign-in failed');
      setAuthErrorModalOpen(true);
      showDriveToast('Sign-in failed: ' + (err?.message || 'error'));
    } finally {
      setIsGoogleLoading(false);
    }
  };

  const handleGoogleSignOut = async () => {
    try {
      await googleSignOut();
    } catch (e) {
      console.warn(e);
    }
    setIsGoogleConnected(false);
    setGoogleAccessToken(null);
    setUserProfile(null);
    setSharedDrives([]);
    setFiles([]);
    setFolders([]);
    setSyncStats(s => ({ ...s, status: 'idle', totalSyncedCount: 0 }));
    showDriveToast('Signed out');
  };

  const handleSyncGoogleDrive = async (
    fileType?: DriveFileTypeFilter,
    corpusOverride?: DriveCorpus,
    driveIdOverride?: string
  ) => {
    if (syncInFlightRef.current) {
      showDriveToast('Sync already in progress');
      return;
    }
    syncInFlightRef.current = true;
    let token = (await ensureValidToken()) || googleAccessToken || (await getAccessToken());
    if (!token) {
      syncInFlightRef.current = false;
      handleGoogleSignIn();
      return;
    }
    setGoogleAccessToken(token);
    const typeToUse = fileType || driveFileTypeFilter;
    const corpus = corpusOverride ?? driveCorpus;
    const dId = driveIdOverride !== undefined ? driveIdOverride : sharedDriveId;

    const runFetch = async (tok: string) => {
      const result = await runDriveSync({
        token: tok,
        typeToUse,
        corpus,
        driveId: dId || undefined,
        currentFiles: files,
        currentFolders: folders,
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
      showDriveToast(result.message);
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
      syncInFlightRef.current = false;
    }
  };

  return {
    handleUploadFile, handleUploadToDrive, handleConnectDemoDrive,
    handleGoogleSignIn, handleGoogleSignOut, handleSyncGoogleDrive,
  };
}
