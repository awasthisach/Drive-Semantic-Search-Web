import React, { useState, useMemo, useRef } from 'react';
import { CheckCircle2, CheckSquare, Square, X, Lock, UploadCloud, Loader2 } from 'lucide-react';
import {
  DeviceStorageFile, StorageSource, DriveFile, VaultFile, FileCategory,
} from '../types';
import { MOCK_DEVICE_FILES } from '../lib/deviceStorageMock';
import { formatBytes } from '../lib/driveApi';
import { encryptDataWithWorker } from '../lib/cryptoVault';

interface DeviceStorageScannerProps {
  onImportToDrive: (file: DriveFile) => void;
  onImportToVault: (vaultFile: VaultFile) => void;
  onUploadToDrive?: (file: File) => Promise<void>;
  isGoogleConnected?: boolean;
  onSelectPreviewFile?: (file: DriveFile) => void;
}

type TypeFilter = 'all' | 'large' | 'duplicates' | 'junk' | 'video' | 'image' | 'document';
const TYPE_FILTERS: TypeFilter[] = ['all', 'large', 'duplicates', 'junk', 'video', 'image', 'document'];

// Non-standard attrs (Chromium/WebKit folder picker) not in React's input typings.
const DIRECTORY_PICKER_ATTRS = { webkitdirectory: '', directory: '' } as React.InputHTMLAttributes<HTMLInputElement>;

const VAULT_MAX_BYTES = 2 * 1024 * 1024;
const isTextLike = (f: File) =>
  f.type.startsWith('text/') ||
  /json|xml|csv|javascript|markdown/.test(f.type) ||
  /\.(txt|md|csv|json|xml|log|ini|yml|yaml|js|ts|py|html|css)$/i.test(f.name);

export const DeviceStorageScanner: React.FC<DeviceStorageScannerProps> = ({
  onImportToDrive, onImportToVault, onUploadToDrive, isGoogleConnected = false,
}) => {
  const [deviceFiles, setDeviceFiles] = useState<DeviceStorageFile[]>(MOCK_DEVICE_FILES);
  const [isScanning, setIsScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState(0);
  const [scanCurrentItem, setScanCurrentItem] = useState('');
  const [lastScannedSource, setLastScannedSource] = useState('Phone Memory & SD Card');
  const [activeSourceFilter, setActiveSourceFilter] = useState<'all' | StorageSource>('all');
  const [activeTypeFilter, setActiveTypeFilter] = useState<TypeFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedFileIds, setSelectedFileIds] = useState<Set<string>>(new Set());
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [vaultPassphrase, setVaultPassphrase] = useState('');
  const [showVaultPassphrase, setShowVaultPassphrase] = useState(false);
  const [busyAction, setBusyAction] = useState<'upload' | 'vault' | null>(null);
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
    setDeviceFiles(prev => {
      const merged = [...newFiles, ...prev];
      const seen = new Map<string, number>();
      for (const f of merged) {
        const key = `${f.name.toLowerCase()}|${f.size}`;
        seen.set(key, (seen.get(key) || 0) + 1);
      }
      return merged.map(f => ({ ...f, isDuplicate: (seen.get(`${f.name.toLowerCase()}|${f.size}`) || 0) > 1 }));
    });
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

  const handleUploadToDrive = async (filesToUpload: DeviceStorageFile[]) => {
    if (!onUploadToDrive) return;
    const withBytes = filesToUpload.filter(f => f.rawFileRef);
    if (withBytes.length === 0) {
      showToast('Nothing to upload: only files picked via the folder picker have bytes (demo items are metadata only).');
      return;
    }
    setBusyAction('upload');
    let ok = 0;
    try {
      for (const f of withBytes) {
        const raw = f.rawFileRef;
        if (!raw) continue;
        try {
          await onUploadToDrive(raw);
          ok++;
        } catch (err) {
          console.warn('Drive upload failed for', f.name, err);
        }
      }
    } finally {
      setBusyAction(null);
    }
    showToast(`Drive upload finished for ${ok}/${withBytes.length} file(s)${filesToUpload.length > withBytes.length ? ` (${filesToUpload.length - withBytes.length} skipped: demo items have no bytes)` : ''}. Check Dashboard for results.`);
  };

  const vaultEligible = (f: DeviceStorageFile) =>
    !!f.rawFileRef && f.rawFileRef.size <= VAULT_MAX_BYTES && isTextLike(f.rawFileRef);

  const handleEncryptToVault = async (filesToVault: DeviceStorageFile[]) => {
    const eligible = filesToVault.filter(vaultEligible);
    if (eligible.length === 0) {
      showToast('Vault accepts picked text-like files up to 2 MB (txt, md, csv, json, code). Demo items have no bytes.');
      return;
    }
    if (!showVaultPassphrase) {
      setShowVaultPassphrase(true);
      return;
    }
    if (vaultPassphrase.length < 8) {
      showToast('Passphrase must be at least 8 characters');
      return;
    }
    setBusyAction('vault');
    let ok = 0;
    try {
      for (const f of eligible) {
        const raw = f.rawFileRef;
        if (!raw) continue;
        try {
          const text = await raw.text();
          const { ciphertext, iv, salt } = await encryptDataWithWorker(text, vaultPassphrase);
          onImportToVault({
            id: `vault-${Date.now()}-${ok}`,
            name: f.name + '.aes',
            originalName: f.name,
            size: text.length,
            mimeType: f.mimeType || 'text/plain',
            encryptedData: ciphertext,
            iv,
            salt,
            uploadedAt: new Date().toISOString(),
            tags: ['device-scan', f.source, f.category],
            notes: `Encrypted in browser with AES-GCM from ${f.path}`,
          });
          ok++;
        } catch (err) {
          console.warn('Vault encrypt failed for', f.name, err);
        }
      }
    } finally {
      setBusyAction(null);
      setVaultPassphrase('');
      setShowVaultPassphrase(false);
    }
    showToast(`Encrypted ${ok}/${eligible.length} file(s) into Privacy Vault${filesToVault.length > eligible.length ? ` (${filesToVault.length - eligible.length} skipped: not text-like or no bytes)` : ''}`);
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

      <input type="file" ref={phoneFolderInputRef} {...DIRECTORY_PICKER_ATTRS} multiple className="hidden"
        onChange={e => handleDirectoryPicked(e, 'phone_internal')} />
      <input type="file" ref={sdFolderInputRef} {...DIRECTORY_PICKER_ATTRS} multiple className="hidden"
        onChange={e => handleDirectoryPicked(e, 'sd_card')} />

      <div className="rounded-2xl bg-zinc-900 text-white p-5 space-y-3">
        <h2 className="text-lg font-bold">Device Storage Scanner</h2>
        <p className="text-xs text-zinc-400">
          Deep Scan shows demo data. Pick a folder to list real files (browser metadata only — never deletes from your device).
          Picked files can be uploaded to Drive{isGoogleConnected ? '' : ' after Google sign-in'} or text files encrypted into the Vault.
        </p>
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={isScanning} onClick={handleTriggerScan}
            className="px-3 py-2 rounded-xl bg-blue-600 text-xs font-bold disabled:opacity-50">
            {isScanning ? `Scanning ${scanProgress}%` : 'Deep Scan (demo)'}
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
        <select value={activeSourceFilter} onChange={e => setActiveSourceFilter(e.target.value as 'all' | StorageSource)}
          className="px-3 py-2 rounded-xl border text-xs">
          <option value="all">All sources</option>
          <option value="phone_internal">Phone</option>
          <option value="sd_card">SD</option>
        </select>
        <select value={activeTypeFilter} onChange={e => setActiveTypeFilter(e.target.value as TypeFilter)}
          className="px-3 py-2 rounded-xl border text-xs">
          {TYPE_FILTERS.map(t => (
            <option key={t} value={t}>{t === 'all' ? 'All types' : t.charAt(0).toUpperCase() + t.slice(1)}</option>
          ))}
        </select>
        <button type="button" className="px-2.5 py-2 rounded-xl border text-xs font-semibold"
          onClick={() => setSelectedFileIds(prev => prev.size === filteredFiles.length ? new Set() : new Set(filteredFiles.map(f => f.id)))}>
          {filteredFiles.length > 0 && selectedFileIds.size === filteredFiles.length ? 'Deselect all' : 'Select all'}
        </button>
      </div>

      {selectedFiles.length > 0 && (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2 text-xs items-center">
            <span className="font-semibold">{selectedFiles.length} selected</span>
            <button type="button" className="px-2 py-1 rounded-lg border" title="Add metadata to the Dashboard file list (no upload)" onClick={() => handleBackupToDrive(selectedFiles)}>Add to Dashboard list</button>
            {isGoogleConnected && onUploadToDrive && (
              <button type="button" disabled={busyAction !== null} className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-blue-600 text-white font-bold disabled:opacity-50" onClick={() => handleUploadToDrive(selectedFiles)}>
                {busyAction === 'upload' ? <Loader2 className="w-3 h-3 animate-spin" /> : <UploadCloud className="w-3 h-3" />} Upload to Drive
              </button>
            )}
            <button type="button" disabled={busyAction !== null} className="inline-flex items-center gap-1 px-2 py-1 rounded-lg border disabled:opacity-50" onClick={() => handleEncryptToVault(selectedFiles)}>
              {busyAction === 'vault' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Lock className="w-3 h-3" />} Encrypt to Vault
            </button>
            <button type="button" className="px-2 py-1 rounded-lg border text-red-600" onClick={() => handleDeleteFiles(Array.from(selectedFileIds))}>Remove from list</button>
          </div>
          {showVaultPassphrase && (
            <form
              className="flex flex-wrap gap-2 items-center text-xs"
              onSubmit={e => { e.preventDefault(); handleEncryptToVault(selectedFiles); }}
            >
              <input
                type="password"
                autoFocus
                value={vaultPassphrase}
                onChange={e => setVaultPassphrase(e.target.value)}
                placeholder="Vault passphrase (min 8 chars)"
                className="px-3 py-1.5 rounded-lg border bg-white dark:bg-zinc-900 min-w-[220px]"
              />
              <button type="submit" disabled={vaultPassphrase.length < 8 || busyAction !== null} className="px-2 py-1.5 rounded-lg bg-indigo-600 text-white font-bold disabled:opacity-50">Encrypt now</button>
              <button type="button" className="px-2 py-1.5 rounded-lg border" onClick={() => { setShowVaultPassphrase(false); setVaultPassphrase(''); }}>Cancel</button>
              <span className="text-zinc-500">Use the same passphrase to unlock in the Vault tab.</span>
            </form>
          )}
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
              <div className="text-[10px] text-zinc-500">
                {formatBytes(f.size)} • {f.source} • {f.category}
                {f.rawFileRef ? ' • picked' : ' • demo'}
                {f.isDuplicate ? ' • duplicate' : ''}
                {f.isLargeFile ? ' • large' : ''}
                {f.isCacheOrJunk ? ' • junk' : ''}
              </div>
            </div>
          </div>
        ))}
      </div>

      {filteredFiles.length === 0 && (
        <p className="text-center text-sm text-zinc-500 py-8">No device files in list. Run demo scan or pick a folder.</p>
      )}
    </div>
  );
};
