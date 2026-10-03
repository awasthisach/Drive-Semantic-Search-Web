import React from 'react';
import { CheckCircle2, X } from 'lucide-react';
import { BrandMark, BrandFooter } from './components/BrandMark';
import { Dashboard } from './components/Dashboard';
import { OfflineIndicator } from './components/OfflineIndicator';
import { MoveToFolderModal } from './components/MoveToFolderModal';
import { AuthErrorModal } from './components/AuthErrorModal';
import { SemanticSearch } from './components/SemanticSearch';
import { useDriveApp } from './hooks/useDriveApp';
import { downloadDiagnostics } from './lib/diagnostics';
import {
  isEmbeddingConsentGranted,
  revokeEmbeddingConsent,
} from './lib/embeddings/consent';
import { isEmbedConfigured } from './lib/embeddings/config';
import { EmbeddingConsentModal } from './components/EmbeddingConsentModal';
import type { DriveFile } from './types';
import { extractDriveFileTextWithTimeout } from './lib/contentExtract';
import { buildEmbeddingChunks, MAX_INDEX_CHARS, putIndexedDocument } from './lib/contentIndex';
import { createEmbeddingProvider } from './lib/embeddings/client';
import { getFirebaseIdToken } from './lib/firebaseAuth';
import { embedAndStoreChunks } from './lib/vectorIndex';

const DeviceStorageScanner = React.lazy(() =>
  import('./components/DeviceStorageScanner').then(m => ({ default: m.DeviceStorageScanner }))
);
const PrivacyVault = React.lazy(() =>
  import('./components/PrivacyVault').then(m => ({ default: m.PrivacyVault }))
);
const DuplicateFinder = React.lazy(() =>
  import('./components/DuplicateFinder').then(m => ({ default: m.DuplicateFinder }))
);
const OfflineFilesList = React.lazy(() =>
  import('./components/OfflineFilesList').then(m => ({ default: m.OfflineFilesList }))
);
const LocalBackupManager = React.lazy(() =>
  import('./components/LocalBackupManager').then(m => ({ default: m.LocalBackupManager }))
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

function formatSyncStatus(status: string, loading: boolean): string {
  if (loading) return 'Syncing\u2026';
  switch (status) {
    case 'not_connected': return 'Not connected';
    case 'demo': return 'Demo mode';
    case 'connected': return 'Connected';
    case 'offline_only': return 'Offline only';
    case 'error': return 'Sync error';
    case 'pending': return 'Partial sync';
    case 'syncing': return 'Syncing\u2026';
    case 'synced': return 'Synced';
    default: return status;
  }
}

export default function App() {
  const {
    files, folders, vaultFiles, vaultLoaded,
    isGoogleConnected, isGoogleLoading, googleAccessToken,
    driveFileTypeFilter, setDriveFileTypeFilter, driveCorpus, setDriveCorpus,
    sharedDriveId, setSharedDriveId, sharedDrives,
    driveTruncated, driveNotification, setDriveNotification,
    authErrorModalOpen, setAuthErrorModalOpen, authErrorMessage,
    activeTab, setActiveTab, syncStats, previewFile, setPreviewFile,
    searchMoveTargetFile, setSearchMoveTargetFile, verifyBusy, userProfile,
    showDriveToast,
    handleUploadFile, handleUploadToDrive, handleConnectDemoDrive,
    handleGoogleSignIn, handleGoogleSignOut, handleSyncGoogleDrive,
    handleDeleteFile, handleRemoveMultipleFiles, handleCreateFolder,
    handleMoveFilesToFolder, handleToggleStar, handleToggleOffline,
    handleVerifyHashes, handleAddVaultFile, handleDeleteVaultFile,
    makeCorpusKey, ensureValidToken, getAccessToken,
  } = useDriveApp();

  const [searchMoveTargets, setSearchMoveTargets] = React.useState<DriveFile[]>([]);
  const [searchMoveSuggestedFolderId, setSearchMoveSuggestedFolderId] = React.useState<string | undefined>();
  const [consentModalOpen, setConsentModalOpen] = React.useState(false);
  const [embedConsentOn, setEmbedConsentOn] = React.useState(() => isEmbeddingConsentGranted());
  const [deepCheckBusy, setDeepCheckBusy] = React.useState(false);

  React.useEffect(() => {
    if (searchMoveTargetFile) {
      setSearchMoveTargets([searchMoveTargetFile]);
    }
  }, [searchMoveTargetFile]);

  const closeMoveModal = () => {
    setSearchMoveTargets([]);
    setSearchMoveSuggestedFolderId(undefined);
    setSearchMoveTargetFile(null);
  };

  const handleReviewFolderSuggestion = (file: DriveFile, folderId: string) => {
    setSearchMoveSuggestedFolderId(folderId);
    setSearchMoveTargets([file]);
    setSearchMoveTargetFile(file);
  };

  const handleDeepSemanticCheck = React.useCallback(async (fileIds: string[]) => {
    if (!isEmbeddingConsentGranted()) {
      throw new Error('Enable embeddings first; expanded OCR text is sent through the configured embedding Worker only with your consent.');
    }
    if (!isEmbedConfigured()) throw new Error('The semantic embedding Worker is not configured.');
    const token = (await ensureValidToken()) || googleAccessToken || (await getAccessToken());
    if (!token) throw new Error('Sign in to Google Drive before checking more pages.');

    const wanted = new Set(fileIds);
    const pdfs = files.filter(file =>
      wanted.has(file.id) && Boolean(file.isGoogleDriveItem) &&
      (file.mimeType === 'application/pdf' || /\.pdf$/i.test(file.name || ''))
    );
    if (!pdfs.length) throw new Error('No Google Drive PDFs were available in this borderline pair.');

    setDeepCheckBusy(true);
    try {
      const corpusKey = makeCorpusKey(driveCorpus, sharedDriveId || undefined);
      const provider = createEmbeddingProvider(() => getFirebaseIdToken());
      let updated = 0;
      for (const file of pdfs) {
        const result = await extractDriveFileTextWithTimeout(
          token,
          file.id,
          file.mimeType || 'application/pdf',
          file.name || '',
          { pdfOcrMode: 'expanded' }
        );
        const text = result.text.slice(0, MAX_INDEX_CHARS);
        if (!text.trim()) continue;
        const chunks = buildEmbeddingChunks(file.name, text);
        const embedding = await embedAndStoreChunks({
          provider,
          fileId: file.id,
          chunks,
          corpusKey,
          driveModifiedTime: file.modifiedTime,
        });
        if (embedding.failed) throw new Error(`Could not update semantic vectors for ${file.name}.`);
        await putIndexedDocument({
          id: file.id,
          name: file.name,
          mimeType: file.mimeType || 'application/pdf',
          text,
          source: result.source,
          driveModifiedTime: file.modifiedTime,
          textTruncated: result.truncated,
          extractionPolicyVersion: result.extractionPolicyVersion,
          pdfCoverage: result.pdfCoverage,
          corpusKey,
          preserveVectors: true,
        });
        updated++;
      }
      if (!updated) throw new Error('No additional PDF text was available to index.');
    } finally {
      setDeepCheckBusy(false);
    }
  }, [files, ensureValidToken, googleAccessToken, getAccessToken, makeCorpusKey, driveCorpus, sharedDriveId]);

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100">
      <header className="sticky top-0 z-40 border-b border-zinc-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/90 backdrop-blur px-4 py-3 flex items-center justify-between gap-3">
        <BrandMark size={34} />
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void handleSyncGoogleDrive()}
            disabled={isGoogleLoading || !isGoogleConnected}
            title={isGoogleConnected ? 'Sync Google Drive now' : 'Connect Google Drive to sync'}
            className="text-[10px] font-semibold px-2 py-1 rounded-full border border-zinc-200 dark:border-zinc-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {formatSyncStatus(syncStats.status, isGoogleLoading)}
          </button>
          {isEmbedConfigured() ? (
            <button
              type="button"
              onClick={() => {
                if (embedConsentOn) {
                  revokeEmbeddingConsent();
                  setEmbedConsentOn(false);
                } else {
                  setConsentModalOpen(true);
                }
              }}
              className="text-xs px-2 py-1 rounded-lg border border-zinc-200 dark:border-zinc-700"
              title={embedConsentOn ? 'Revoke embedding consent' : 'Enable semantic embeddings'}
            >
              {embedConsentOn ? 'Embeddings on' : 'Enable embeddings'}
            </button>
          ) : null}
          <button type="button" onClick={downloadDiagnostics} className="text-xs px-2 py-1 rounded-lg border border-zinc-200 dark:border-zinc-700" title="Export local diagnostics JSON (tokens redacted)">Diagnostics</button>
          {isGoogleConnected ? (
            <button type="button" onClick={handleGoogleSignOut} className="text-xs px-2 py-1 rounded-lg border border-zinc-200 dark:border-zinc-700">Sign out</button>
          ) : null}
        </div>
      </header>

      <nav className="flex gap-1 px-3 py-2 overflow-x-auto border-b border-zinc-200 dark:border-zinc-800 text-xs font-semibold">
        {(['dashboard', 'search', 'duplicates', 'vault', 'storage_scanner', 'offline', 'backup'] as const).map(id => (
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
            onSelectTab={tab => setActiveTab(tab)} onSelectPreviewFile={setPreviewFile}
            isGoogleConnected={isGoogleConnected} isGoogleLoading={isGoogleLoading}
            googleUserEmail={userProfile.email}
            onConnectGoogleDrive={handleGoogleSignIn} onConnectDemoDrive={handleConnectDemoDrive}
            onSyncGoogleDrive={handleSyncGoogleDrive}
            driveFileTypeFilter={driveFileTypeFilter}
            onDriveFileTypeChange={t => { setDriveFileTypeFilter(t); handleSyncGoogleDrive(t); }}
            driveTruncated={driveTruncated}
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
              } catch {}
              handleSyncGoogleDrive(undefined, c, id);
            }}
          />
        )}
        {activeTab === 'search' && (
          <React.Suspense fallback={<TabLoadingFallback />}>
            <SemanticSearch
              files={files}
              folders={folders}
              onSelectFile={setPreviewFile}
              onMoveFile={f => {
                setSearchMoveSuggestedFolderId(undefined);
                setSearchMoveTargets([f]);
                setSearchMoveTargetFile(f);
              }}
              onMoveFiles={list => {
                setSearchMoveSuggestedFolderId(undefined);
                setSearchMoveTargets(list);
                setSearchMoveTargetFile(list[0] || null);
              }}
              onReviewFolderSuggestion={handleReviewFolderSuggestion}
              onToggleStar={handleToggleStar}
              onToggleOffline={handleToggleOffline}
              accessToken={googleAccessToken}
              onRequestToken={async () => (await ensureValidToken()) || googleAccessToken || (await getAccessToken())}
              corpusKey={makeCorpusKey(driveCorpus, sharedDriveId || undefined)}
            />
          </React.Suspense>
        )}
        {activeTab === 'duplicates' && (
          <React.Suspense fallback={<TabLoadingFallback />}>
            <DuplicateFinder
              files={files}
              folders={folders}
              corpusKey={makeCorpusKey(driveCorpus, sharedDriveId || undefined)}
              onRemoveFiles={handleRemoveMultipleFiles}
              onMoveFiles={handleMoveFilesToFolder}
              onCreateFolder={handleCreateFolder}
              onVerifyHashes={handleVerifyHashes}
              verifyBusy={verifyBusy}
              onDeepCheck={handleDeepSemanticCheck}
              deepCheckBusy={deepCheckBusy}
            />
          </React.Suspense>
        )}
        {activeTab === 'vault' && (
          <React.Suspense fallback={<TabLoadingFallback />}>
            <PrivacyVault vaultFiles={vaultFiles} vaultLoaded={vaultLoaded} onAddVaultFile={handleAddVaultFile} onDeleteVaultFile={handleDeleteVaultFile} />
          </React.Suspense>
        )}
        {activeTab === 'storage_scanner' && (
          <React.Suspense fallback={<TabLoadingFallback />}>
            <DeviceStorageScanner
              onImportToDrive={(file) => { handleUploadFile(file); showDriveToast('Imported to local list: ' + file.name); }}
              onSelectPreviewFile={setPreviewFile}
            />
          </React.Suspense>
        )}
        {activeTab === 'offline' && (
          <React.Suspense fallback={<TabLoadingFallback />}>
            <OfflineFilesList files={files} onToggleOffline={handleToggleOffline} onSelectFile={setPreviewFile} />
          </React.Suspense>
        )}
        {activeTab === 'backup' && (
          <React.Suspense fallback={<TabLoadingFallback />}>
            <LocalBackupManager />
          </React.Suspense>
        )}
      </main>

      <OfflineIndicator />

      {driveNotification && (
        <div className="fixed bottom-4 right-4 z-50 flex items-center gap-2 px-4 py-2.5 rounded-2xl bg-zinc-900 text-zinc-100 shadow-2xl text-xs font-semibold max-w-sm">
          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
          <span>{driveNotification}</span>
          <button type="button" onClick={() => setDriveNotification(null)}><X className="w-3.5 h-3.5" /></button>
        </div>
      )}

      <AuthErrorModal
        isOpen={authErrorModalOpen}
        errorMessage={authErrorMessage}
        onClose={() => setAuthErrorModalOpen(false)}
        onRetrySignIn={() => { setAuthErrorModalOpen(false); handleGoogleSignIn(); }}
        onConnectDemoDrive={() => { setAuthErrorModalOpen(false); handleConnectDemoDrive(); }}
        isLoading={isGoogleLoading}
      />

      {previewFile && (
        <React.Suspense fallback={null}>
          <FilePreviewModal
            file={previewFile}
            onClose={() => setPreviewFile(null)}
            onToggleOffline={() => handleToggleOffline(previewFile.id)}
            onMove={() => {
              setSearchMoveSuggestedFolderId(undefined);
              setSearchMoveTargets([previewFile]);
              setSearchMoveTargetFile(previewFile);
              setPreviewFile(null);
            }}
          />
        </React.Suspense>
      )}

      <BrandFooter />

      <EmbeddingConsentModal
        open={consentModalOpen}
        onClose={() => setConsentModalOpen(false)}
        onAllow={() => {
          setEmbedConsentOn(true);
          setConsentModalOpen(false);
        }}
        onTextOnly={() => {
          setConsentModalOpen(false);
        }}
      />

      {searchMoveTargets.length > 0 && (
          <MoveToFolderModal
            isOpen={searchMoveTargets.length > 0}
            onClose={closeMoveModal}
            selectedFiles={searchMoveTargets}
            folders={folders}
            allFiles={files}
            suggestedFolderId={searchMoveSuggestedFolderId}
          onConfirmMove={(folderId) => {
            handleMoveFilesToFolder(searchMoveTargets.map(f => f.id), folderId);
            closeMoveModal();
          }}
          onCreateFolder={handleCreateFolder}
        />
      )}
    </div>
  );
}
