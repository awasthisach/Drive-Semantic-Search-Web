import React, { useState, useMemo } from 'react';
import {
  UploadCloud, Star, CheckCircle2, Cloud,
  X, CheckSquare, Square, Search, RefreshCw, FolderInput,
} from 'lucide-react';
import { DriveFile, FileCategory, VaultFile, FolderItem, AppTab } from '../types';
import { formatBytes } from '../lib/driveApi';
import { runSemanticSearch } from '../lib/searchEngine';
import { DriveFileTypeFilter, DriveCorpus, SharedDriveInfo } from '../lib/googleDriveService';
import { FileTypeSelector } from './FileTypeSelector';
import { MoveToFolderModal } from './MoveToFolderModal';
import { DeleteConfirmModal } from './DeleteConfirmModal';

interface DashboardProps {
  files: DriveFile[];
  folders: FolderItem[];
  vaultFiles: VaultFile[];
  onUploadFile: (newFile: DriveFile) => void;
  onUploadToDrive?: (file: File) => Promise<void>;
  onDeleteFile: (id: string) => void;
  onDeleteMultipleFiles: (ids: string[]) => void;
  onMoveFilesToFolder: (fileIds: string[], targetFolderId: string | undefined) => void;
  onCreateFolder: (newFolder: FolderItem) => void;
  onToggleStar: (id: string) => void;
  onToggleOffline: (id: string) => void;
  onSelectTab: (tab: AppTab) => void;
  onSelectPreviewFile: (file: DriveFile) => void;
  isGoogleConnected?: boolean;
  isGoogleLoading?: boolean;
  googleUserEmail?: string;
  onConnectGoogleDrive?: () => void;
  onConnectDemoDrive?: () => void;
  onSyncGoogleDrive?: (fileType?: DriveFileTypeFilter) => void;
  driveFileTypeFilter?: DriveFileTypeFilter;
  onDriveFileTypeChange?: (fileType: DriveFileTypeFilter) => void;
  driveTruncated?: boolean;
  driveCorpus?: DriveCorpus;
  sharedDriveId?: string;
  sharedDrives?: SharedDriveInfo[];
  onDriveCorpusChange?: (corpus: DriveCorpus, driveId?: string) => void;
}

export const Dashboard: React.FC<DashboardProps> = ({
  files, folders, vaultFiles, onUploadFile, onUploadToDrive, onDeleteFile, onDeleteMultipleFiles,
  onMoveFilesToFolder, onCreateFolder, onToggleStar, onToggleOffline, onSelectTab,
  onSelectPreviewFile, isGoogleConnected = false, isGoogleLoading = false,
  googleUserEmail = '', onConnectGoogleDrive, onConnectDemoDrive, onSyncGoogleDrive,
  driveFileTypeFilter = 'all', onDriveFileTypeChange, driveTruncated = false,
  driveCorpus = 'user', sharedDriveId = '', sharedDrives = [], onDriveCorpusChange,
}) => {
  const [filterCategory, setFilterCategory] = useState('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedFileIds, setSelectedFileIds] = useState<Set<string>>(new Set());
  const [isMoveModalOpen, setIsMoveModalOpen] = useState(false);
  const [moveTargetFiles, setMoveTargetFiles] = useState<DriveFile[]>([]);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [deleteTargetFiles, setDeleteTargetFiles] = useState<DriveFile[]>([]);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const PAGE_SIZE = 60;
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3500);
  };

  const filteredFiles = useMemo(() => {
    let list = files;
    if (filterCategory === 'starred') list = list.filter(f => f.starred);
    else if (filterCategory === 'google_drive') list = list.filter(f => f.isGoogleDriveItem);
    else if (filterCategory !== 'all') list = list.filter(f => f.category === filterCategory);

    if (!searchTerm.trim()) return list;
    const ranked = runSemanticSearch(searchTerm, list, 'all');
    return ranked.map(r => r.file);
  }, [files, filterCategory, searchTerm]);

  React.useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [filterCategory, searchTerm, files.length]);

  const visibleFiles = useMemo(
    () => filteredFiles.slice(0, visibleCount),
    [filteredFiles, visibleCount]
  );

  const allVisibleSelected =
    visibleFiles.length > 0 && visibleFiles.every(f => selectedFileIds.has(f.id));

  const selectedFilesList = useMemo(() => files.filter(f => selectedFileIds.has(f.id)), [files, selectedFileIds]);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const uploaded = e.target.files?.[0];
    if (!uploaded) return;
    e.target.value = '';

    if (isGoogleConnected && onUploadToDrive) {
      showToast('Uploading "' + uploaded.name + '" to Google Drive...');
      try {
        await onUploadToDrive(uploaded);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'error';
        showToast('Upload failed: ' + msg);
      }
      return;
    }

    let cat: FileCategory = 'document';
    if (uploaded.type.startsWith('image/')) cat = 'image';
    else if (uploaded.type.includes('sheet') || uploaded.name.endsWith('.xlsx')) cat = 'spreadsheet';
    else if (uploaded.type.includes('zip')) cat = 'archive';
    onUploadFile({
      id: 'file-' + Date.now(),
      name: uploaded.name,
      mimeType: uploaded.type || 'application/octet-stream',
      size: uploaded.size || 0,
      modifiedTime: new Date().toISOString(),
      createdTime: new Date().toISOString(),
      category: cat,
      isOffline: true,
      isEncrypted: false,
      contentHash: 'user-' + Date.now() + '-' + uploaded.size,
      tags: ['upload', 'local', cat],
      semanticSummary: 'Local only (not on Google Drive): ' + uploaded.name,
      starred: false,
    });
    showToast('"' + uploaded.name + '" added locally (not uploaded to Google Drive)');
  };

  const toggleSelect = (id: string) => {
    setSelectedFileIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  return (
    <div className="space-y-6">
      {toastMessage && (
        <div className="fixed top-20 right-6 z-50 flex items-center gap-2.5 px-4 py-2.5 rounded-2xl bg-zinc-900 text-zinc-100 shadow-2xl text-xs font-semibold">
          <CheckCircle2 className="w-4 h-4 text-emerald-400" />
          <span>{toastMessage}</span>
          <button type="button" onClick={() => setToastMessage(null)}><X className="w-3.5 h-3.5" /></button>
        </div>
      )}

      {isGoogleConnected ? (
        <div className="rounded-2xl p-4 bg-gradient-to-r from-blue-50 to-indigo-50/70 dark:from-blue-950/30 dark:to-indigo-950/20 border border-blue-200 dark:border-blue-900/40 flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-blue-600 text-white"><Cloud className="w-5 h-5" /></div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-bold">Google Drive Live Sync</span>
                <span className="text-[10px] font-semibold text-emerald-600 bg-emerald-500/10 px-2 py-0.5 rounded-full border border-emerald-500/20">Connected</span>
              </div>
              <p className="text-[11px] text-zinc-600 dark:text-zinc-400 mt-0.5">
                {googleUserEmail || 'Signed in'} • {files.filter(f => f.isGoogleDriveItem).length} Drive files
              </p>
              {driveTruncated && (
                <p className="text-[10px] text-amber-700 dark:text-amber-400 mt-1 font-medium">
                  List may be incomplete (sync capped at ~20k). Use type filters to narrow.
                </p>
              )}
            </div>
          </div>
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
            {onDriveCorpusChange && (
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <label className="text-zinc-500 font-medium">Corpus</label>
                <select
                  value={driveCorpus === 'drive' ? 'drive:' + sharedDriveId : driveCorpus}
                  disabled={isGoogleLoading}
                  onChange={e => {
                    const v = e.target.value;
                    if (v === 'user' || v === 'allDrives') onDriveCorpusChange(v);
                    else if (v.startsWith('drive:')) onDriveCorpusChange('drive', v.slice(6));
                  }}
                  className="px-2 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-xs font-semibold min-h-[38px]"
                >
                  <option value="user">My Drive</option>
                  <option value="allDrives">All drives</option>
                  {sharedDrives.map(d => (
                    <option key={d.id} value={'drive:' + d.id}>{d.name}</option>
                  ))}
                </select>
              </div>
            )}
            {onDriveFileTypeChange && (
              <FileTypeSelector value={driveFileTypeFilter} onChange={onDriveFileTypeChange} disabled={isGoogleLoading} />
            )}
            {onSyncGoogleDrive && (
              <button type="button" onClick={() => onSyncGoogleDrive(driveFileTypeFilter)} disabled={isGoogleLoading}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 text-xs font-semibold disabled:opacity-50 min-h-[38px]">
                <RefreshCw className={`w-3.5 h-3.5 ${isGoogleLoading ? 'animate-spin text-blue-500' : ''}`} />
                <span>{isGoogleLoading ? 'Syncing...' : 'Sync Now'}</span>
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="rounded-2xl p-4 bg-gradient-to-r from-blue-50/70 to-zinc-50 dark:from-blue-950/20 dark:to-zinc-900 border border-blue-200/80 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h4 className="text-sm font-bold">Connect Google Drive</h4>
            <p className="text-[11px] text-zinc-600 dark:text-zinc-400">Sign in to sync, search, and upload to Drive.</p>
          </div>
          <div className="flex gap-2">
            {onConnectGoogleDrive && (
              <button type="button" onClick={onConnectGoogleDrive} disabled={isGoogleLoading}
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-blue-600 text-white text-xs font-bold min-h-[40px]">
                {isGoogleLoading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Cloud className="w-4 h-4" />}
                Sign in with Google
              </button>
            )}
            {onConnectDemoDrive && (
              <button type="button" onClick={onConnectDemoDrive}
                className="px-3.5 py-2.5 rounded-xl bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 text-xs font-semibold min-h-[40px]">
                Demo Drive
              </button>
            )}
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[160px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-400" />
          <input value={searchTerm} onChange={e => setSearchTerm(e.target.value)} placeholder="Search files..."
            className="w-full pl-9 pr-3 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm" />
        </div>
        <select value={filterCategory} onChange={e => setFilterCategory(e.target.value)}
          className="px-3 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-xs font-semibold">
          <option value="all">All types</option>
          <option value="document">Documents</option>
          <option value="image">Images</option>
          <option value="spreadsheet">Spreadsheets</option>
          <option value="starred">Starred</option>
          <option value="google_drive">Google Drive</option>
        </select>
        <label className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-blue-600 text-white text-xs font-bold cursor-pointer">
          <UploadCloud className="w-3.5 h-3.5" />
          {isGoogleConnected ? 'Upload to Drive' : 'Upload'}
          <input type="file" className="hidden" onChange={handleFileUpload} />
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <button
          type="button"
          className="px-2.5 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 font-semibold"
          onClick={() => {
            setSelectedFileIds(prev => {
              const next = new Set(prev);
              if (allVisibleSelected) {
                for (const f of visibleFiles) next.delete(f.id);
              } else {
                for (const f of visibleFiles) next.add(f.id);
              }
              return next;
            });
          }}
        >
          {allVisibleSelected ? 'Deselect all visible' : 'Select all visible'}
        </button>
        {selectedFilesList.length > 0 && (
          <>
            <span className="font-semibold text-blue-600">{selectedFilesList.length} selected</span>
            <button
              type="button"
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-indigo-600 text-white font-bold"
              onClick={() => { setMoveTargetFiles(selectedFilesList); setIsMoveModalOpen(true); }}
            >
              <FolderInput className="w-3.5 h-3.5" /> Move to folder
            </button>
            <button type="button" className="px-2 py-1.5 rounded-lg border text-red-600 font-semibold" onClick={() => { setDeleteTargetFiles(selectedFilesList); setIsDeleteModalOpen(true); }}>Delete</button>
            <button type="button" className="px-2 py-1.5 rounded-lg border" onClick={() => setSelectedFileIds(new Set())}>Clear</button>
          </>
        )}
        {selectedFilesList.length === 0 && (
          <span className="text-zinc-500">Tip: select checkboxes then use <strong>Move to folder</strong>, or card <strong>Move</strong></span>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {visibleFiles.map(file => (
          <div key={file.id} className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3 hover:border-blue-400 transition cursor-pointer"
            onClick={() => onSelectPreviewFile(file)}>
            <div className="flex items-start gap-2">
              <button type="button" onClick={e => { e.stopPropagation(); toggleSelect(file.id); }} className="mt-0.5">
                {selectedFileIds.has(file.id) ? <CheckSquare className="w-4 h-4 text-blue-600" /> : <Square className="w-4 h-4 text-zinc-400" />}
              </button>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold truncate">{file.name}</div>
                <div className="text-[11px] text-zinc-500 mt-0.5">{formatBytes(file.size)} • {file.category}</div>
                {file.isGoogleDriveItem && <span className="text-[10px] text-blue-600 font-semibold">Drive</span>}
              </div>
              <div className="flex flex-col items-end gap-1 shrink-0">
                <button type="button" onClick={e => { e.stopPropagation(); onToggleStar(file.id); }} title="Star">
                  <Star className={`w-4 h-4 ${file.starred ? 'text-amber-500 fill-amber-500' : 'text-zinc-400'}`} />
                </button>
                <button
                  type="button"
                  title="Move to folder"
                  className="inline-flex items-center gap-0.5 text-[10px] font-bold text-indigo-600 hover:underline"
                  onClick={e => {
                    e.stopPropagation();
                    setMoveTargetFiles([file]);
                    setIsMoveModalOpen(true);
                  }}
                >
                  <FolderInput className="w-3.5 h-3.5" /> Move
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {filteredFiles.length === 0 && (
        <div className="text-center py-12 text-sm text-zinc-500">No files found. Connect Drive and Sync.</div>
      )}

      {filteredFiles.length > visibleCount && (
        <div className="flex justify-center pt-2">
          <button
            type="button"
            className="px-4 py-2 rounded-xl border border-zinc-300 dark:border-zinc-700 text-sm font-semibold hover:bg-zinc-50 dark:hover:bg-zinc-800"
            onClick={() => setVisibleCount(c => c + PAGE_SIZE)}
          >
            Load more ({visibleCount} / {filteredFiles.length})
          </button>
        </div>
      )}

      <MoveToFolderModal
        isOpen={isMoveModalOpen}
        onClose={() => setIsMoveModalOpen(false)}
        selectedFiles={moveTargetFiles}
        folders={folders}
        allFiles={files}
        onConfirmMove={(folderId) => {
          onMoveFilesToFolder(moveTargetFiles.map(f => f.id), folderId);
          setIsMoveModalOpen(false);
          setSelectedFileIds(new Set());
          showToast('Files moved');
        }}
        onCreateFolder={onCreateFolder}
      />
      <DeleteConfirmModal
        isOpen={isDeleteModalOpen}
        onClose={() => setIsDeleteModalOpen(false)}
        filesToDelete={deleteTargetFiles}
        onConfirmDelete={() => {
          onDeleteMultipleFiles(deleteTargetFiles.map(f => f.id));
          setIsDeleteModalOpen(false);
          setSelectedFileIds(new Set());
          showToast('Delete requested');
        }}
      />
    </div>
  );
};
