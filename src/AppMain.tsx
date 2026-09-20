import React from 'react';
import { Cloud, CheckCircle2, X } from 'lucide-react';
import { Dashboard } from './components/Dashboard';
import { OfflineIndicator } from './components/OfflineIndicator';
import { MoveToFolderModal } from './components/MoveToFolderModal';
import { AuthErrorModal } from './components/AuthErrorModal';
import { useDriveApp } from './hooks/useDriveApp';

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
  const {
    files, folders, vaultFiles,
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
              onMoveFile={f => setSearchMoveTargetFile(f)}
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
            <DeviceStorageScanner
              onImportToDrive={(file) => { handleUploadFile(file); showDriveToast('Imported to local list: ' + file.name); }}
              onImportToVault={() => showDriveToast('Use Vault tab to encrypt notes')}
            />
          </React.Suspense>
        )}
        {activeTab === 'offline' && (
          <React.Suspense fallback={<TabLoadingFallback />}>
            <OfflineFilesList files={files} onToggleOffline={handleToggleOffline} onSelectFile={setPreviewFile} />
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
            onMove={() => { setSearchMoveTargetFile(previewFile); setPreviewFile(null); }}
          />
        </React.Suspense>
      )}

      {searchMoveTargetFile && (
        <MoveToFolderModal
          isOpen={Boolean(searchMoveTargetFile)}
          onClose={() => setSearchMoveTargetFile(null)}
          selectedFiles={[searchMoveTargetFile]}
          folders={folders}
          allFiles={files}
          onConfirmMove={(folderId) => {
            handleMoveFilesToFolder([searchMoveTargetFile.id], folderId);
            setSearchMoveTargetFile(null);
          }}
          onCreateFolder={handleCreateFolder}
        />
      )}
    </div>
  );
}
