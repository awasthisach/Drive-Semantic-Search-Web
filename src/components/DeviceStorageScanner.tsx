import React, { useState, useMemo, useRef } from 'react';
import {
  CheckCircle2, CheckSquare, Square, X,
} from 'lucide-react';
import {
  DeviceStorageFile, StorageSource, DriveFile, FileCategory,
} from '../types';
import { MOCK_DEVICE_FILES } from '../lib/deviceStorageMock';
import { formatBytes } from '../lib/driveApi';

interface DeviceStorageScannerProps {
  onImportToDrive: (file: DriveFile) => void;
  onSelectPreviewFile?: (file: DriveFile) => void;
}

export const DeviceStorageScanner: React.FC<DeviceStorageScannerProps> = ({
  onImportToDrive, onSelectPreviewFile,
}) => {
  const [deviceFiles, setDeviceFiles] = useState<DeviceStorageFile[]>(MOCK_DEVICE_FILES);
  const [isScanning, setIsScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState(0);
  const [scanCurrentItem, setScanCurrentItem] = useState('');
  const [lastScannedSource, setLastScannedSource] = useState('Phone Memory & SD Card');
  const [activeSourceFilter, setActiveSourceFilter] = useState<'all' | StorageSource>('all');
  const [activeTypeFilter, setActiveTypeFilter] = useState<'all' | 'large' | 'duplicates' | 'junk' | 'video' | 'image' | 'document'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedFileIds, setSelectedFileIds] = useState<Set<string>>(new Set());
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const phoneFolderInputRef = useRef<HTMLInputElement>(null);
  const sdFolderInputRef = useRef<HTMLInputElement>(null);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3500);
  };

  const filteredFiles = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return deviceFiles.filter(f => {
      if (activeSourceFilter !== 'all' && f.source !== activeSourceFilter) return false;
      if (activeTypeFilter === 'large' && !f.isLargeFile) return false;
      if (activeTypeFilter === 'duplicates' && !f.isDuplicate) return false;
      if (activeTypeFilter === 'junk' && !f.isCacheOrJunk) return false;
      if (activeTypeFilter === 'video' && f.category !== 'video') return false;
      if (activeTypeFilter === 'image' && f.category !== 'image') return false;
      if (activeTypeFilter === 'document' && f.category !== 'document') return false;
      if (q) {
        return f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q);
      }
      return true;
    });
  }, [deviceFiles, activeSourceFilter, activeTypeFilter, searchQuery]);

  const selectedFiles = useMemo(
    () => deviceFiles.filter(f => selectedFileIds.has(f.id)),
    [deviceFiles, selectedFileIds]
  );

  const allFilteredSelected = filteredFiles.length > 0 && filteredFiles.every(f => selectedFileIds.has(f.id));

  const asDriveFile = (f: DeviceStorageFile): DriveFile => ({
    id: `device-preview-${f.id}`,
    name: f.name,
    mimeType: f.mimeType,
    size: f.size,
    modifiedTime: f.lastModified,
    createdTime: f.lastModified,
    category: f.category,
    isOffline: false,
    isEncrypted: false,
    contentHash: `device-${f.id}-${f.size}`,
    tags: [f.source, f.category, 'device-picker'],
    semanticSummary: `Selected from ${f.path}. The browser only has access to files you explicitly choose.`,
    starred: false,
  });

  const handleToggleSelect = (id: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setSelectedFileIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handleDirectoryPicked = (e: React.ChangeEvent<HTMLInputElement>, source: StorageSource) => {
    const fileList = e.target.files;
    if (!fileList || fileList.length === 0) return;
    const newFiles: DeviceStorageFile[] = [];
    for (let i = 0; i < fileList.length; i++) {
      const f = fileList[i];
      let cat: FileCategory = 'other';
      if (f.type.startsWith('image/')) cat = 'image';
      else if (f.type.startsWith('video/')) cat = 'video';
      else if (f.type.includes('pdf') || f.name.match(/\.(pdf|doc|docx|txt)$/i)) cat = 'document';
      else if (f.name.match(/\.(zip|rar|7z)$/i)) cat = 'archive';
      newFiles.push({
        id: `scanned-${source}-${Date.now()}-${i}`,
        name: f.name,
        path: f.webkitRelativePath || `${source}/${f.name}`,
        source,
        size: f.size,
        mimeType: f.type || 'application/octet-stream',
        category: cat,
        lastModified: new Date(f.lastModified).toISOString(),
        isLargeFile: f.size > 25 * 1024 * 1024,
        isDuplicate: false,
        isCacheOrJunk: f.name.endsWith('.tmp') || f.name.endsWith('.log'),
        rawFileRef: f,
      });
    }
    setDeviceFiles(prev => [...newFiles, ...prev]);
    showToast(`Indexed ${newFiles.length} files from picker (local metadata only)`);
    e.target.value = '';
  };

  const handleDeleteFiles = (ids: string[]) => {
    const idSet = new Set(ids);
    setDeviceFiles(prev => prev.filter(f => !idSet.has(f.id)));
    setSelectedFileIds(prev => {
      const next = new Set(prev);
      for (const id of ids) next.delete(id);
      return next;
    });
    showToast(`Removed ${ids.length} items from scanner list (UI only — not device filesystem delete)`);
  };

  const handleBackupToDrive = (filesToBackup: DeviceStorageFile[]) => {
    for (const f of filesToBackup) {
      onImportToDrive({
        id: `drive-imported-${f.id}-${Date.now()}`,
        name: f.name,
        mimeType: f.mimeType,
        size: f.size,
        modifiedTime: f.lastModified,
        createdTime: new Date().toISOString(),
        category: f.category,
        isOffline: true,
        isEncrypted: false,
        contentHash: `dev-${f.id}-${f.size}`,
        tags: [f.source, f.category, 'local-index'],
        semanticSummary: `Local index only (not uploaded to Drive): ${f.path}`,
        starred: false,
      });
    }
    showToast(`Indexed ${filesToBackup.length} items locally (not uploaded to Google Drive — bytes stay on device).`);
  };

  const handleTriggerScan = () => {
    setIsScanning(true);
    setScanProgress(0);
    let step = 0;
    const steps = ['Scanning media...', 'Checking duplicates...', 'Finalizing...'];
    const t = setInterval(() => {
      step++;
      setScanProgress(Math.min(100, Math.round((step / steps.length) * 100)));
      setScanCurrentItem(steps[step - 1] || 'Done');
      if (step >= steps.length) {
        clearInterval(t);
        setIsScanning(false);
        showToast(`Scan complete: ${deviceFiles.length} mock/indexed files`);
      }
    }, 300);
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

      <input type="file" ref={phoneFolderInputRef} {...({ webkitdirectory: '', directory: '' } as any)} multiple className="hidden"
        onChange={e => handleDirectoryPicked(e, 'phone_internal')} />
      <input type="file" ref={sdFolderInputRef} {...({ webkitdirectory: '', directory: '' } as any)} multiple className="hidden"
        onChange={e => handleDirectoryPicked(e, 'sd_card')} />

      <div className="rounded-2xl bg-zinc-900 text-white p-5 space-y-3">
        <h2 className="text-lg font-bold">Device File Picker</h2>
        <p className="text-xs text-zinc-400">Browser-safe file metadata only. This page cannot scan the entire Android filesystem or delete device files.</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={isScanning} onClick={handleTriggerScan}
            className="px-3 py-2 rounded-xl bg-blue-600 text-xs font-bold disabled:opacity-50">
            {isScanning ? `Processing ${scanProgress}%` : 'Demo Scan'}
          </button>
          <button type="button" onClick={() => phoneFolderInputRef.current?.click()}
            className="px-3 py-2 rounded-xl bg-zinc-800 border border-zinc-700 text-xs font-semibold">Pick Phone Folder</button>
          <button type="button" onClick={() => sdFolderInputRef.current?.click()}
            className="px-3 py-2 rounded-xl bg-zinc-800 border border-zinc-700 text-xs font-semibold">Pick SD Folder</button>
        </div>
        {isScanning && <p className="text-xs text-blue-400">{scanCurrentItem}</p>}
      </div>

      <div className="flex flex-wrap gap-2 items-center">
        <input value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder="Filter files..."
          className="flex-1 min-w-[140px] px-3 py-2 rounded-xl border text-sm" />
        <select value={activeSourceFilter} onChange={e => setActiveSourceFilter(e.target.value as any)}
          className="px-3 py-2 rounded-xl border text-xs">
          <option value="all">All sources</option>
          <option value="phone_internal">Phone</option>
          <option value="sd_card">SD</option>
        </select>
        <select value={activeTypeFilter} onChange={e => setActiveTypeFilter(e.target.value as typeof activeTypeFilter)}
          className="px-3 py-2 rounded-xl border text-xs">
          <option value="all">All file types</option>
          <option value="document">Documents</option>
          <option value="image">Images</option>
          <option value="video">Videos</option>
          <option value="large">Large files</option>
          <option value="duplicates">Duplicate candidates</option>
          <option value="junk">Cache / junk</option>
        </select>
        <button
          type="button"
          onClick={() => setSelectedFileIds(prev => {
            const next = new Set(prev);
            if (allFilteredSelected) filteredFiles.forEach(f => next.delete(f.id));
            else filteredFiles.forEach(f => next.add(f.id));
            return next;
          })}
          className="px-3 py-2 rounded-xl border text-xs font-semibold"
        >
          {allFilteredSelected ? 'Clear visible' : 'Select visible'}
        </button>
      </div>

      {selectedFiles.length > 0 && (
        <div className="flex flex-wrap gap-2 text-xs">
          <span className="font-semibold">{selectedFiles.length} selected</span>
          <button type="button" className="px-2 py-1 rounded-lg border" onClick={() => handleBackupToDrive(selectedFiles)}>Index locally</button>
          <span className="px-2 py-1 text-zinc-500">Encrypt text from the Vault tab; picked files are never read or encrypted automatically.</span>
          <button type="button" className="px-2 py-1 rounded-lg border text-red-600" onClick={() => handleDeleteFiles(Array.from(selectedFileIds))}>Remove from list</button>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {filteredFiles.map(f => (
          <div key={f.id} className="rounded-xl border p-3 flex gap-2 items-start bg-white dark:bg-zinc-900">
            <button type="button" onClick={e => handleToggleSelect(f.id, e)}>
              {selectedFileIds.has(f.id) ? <CheckSquare className="w-4 h-4 text-blue-600" /> : <Square className="w-4 h-4 text-zinc-400" />}
            </button>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold truncate">{f.name}</div>
              <div className="text-[10px] text-zinc-500">{formatBytes(f.size)} • {f.source} • {f.category}</div>
            </div>
            {onSelectPreviewFile && (
              <button type="button" onClick={() => onSelectPreviewFile(asDriveFile(f))} className="px-2 py-1 rounded-lg border text-[10px] font-semibold">
                Details
              </button>
            )}
          </div>
        ))}
      </div>

      {filteredFiles.length === 0 && (
        <p className="text-center text-sm text-zinc-500 py-8">No device files in list. Pick a folder or run the demo scan.</p>
      )}
    </div>
  );
};
