import React, { useMemo, useState } from 'react';
import { CheckCircle2, CheckSquare, FolderOpen, Loader2, ShieldCheck, Square, X } from 'lucide-react';
import { FileCategory, DriveFile, StorageSource } from '../types';
import { MOCK_DEVICE_FILES } from '../lib/deviceStorageMock';
import { formatBytes } from '../lib/driveApi';

type DirHandle = {
  kind: 'directory';
  name: string;
  entries(): AsyncIterableIterator<[string, FileHandle | DirHandle]>;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<DirHandle>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandle>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  queryPermission?: (o?: { mode?: 'read' | 'readwrite' }) => Promise<PermissionState>;
  requestPermission?: (o?: { mode?: 'read' | 'readwrite' }) => Promise<PermissionState>;
};
type FileHandle = {
  kind: 'file';
  name: string;
  getFile(): Promise<File>;
  queryPermission?: (o?: { mode?: 'read' | 'readwrite' }) => Promise<PermissionState>;
  requestPermission?: (o?: { mode?: 'read' | 'readwrite' }) => Promise<PermissionState>;
  createWritable(): Promise<{ write(data: Blob | ArrayBuffer | string): Promise<void>; close(): Promise<void> }>;
};
type PickedEntry = {
  id: string; name: string; path: string; source: StorageSource; size: number; modifiedTime: string;
  mimeType: string; category: FileCategory; fastFingerprint: string; contentHash?: string;
  fileHandle?: FileHandle; parentHandle?: DirHandle; isDuplicate: boolean; verified: boolean;
};
type PickerWindow = Window & { showDirectoryPicker?: (o?: { id?: string; mode?: 'read' | 'readwrite' }) => Promise<DirHandle> };

const BATCH_SIZE = 40;
const SAMPLE_BYTES = 64 * 1024;

async function permission(handle: DirHandle | FileHandle, mode: 'read' | 'readwrite'): Promise<boolean> {
  if (handle.queryPermission && await handle.queryPermission({ mode }) === 'granted') return true;
  if (handle.requestPermission) return await handle.requestPermission({ mode }) === 'granted';
  return true;
}

async function sha256Bytes(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

/** Cheap first/last sample used only to discover likely duplicate candidates. */
async function fastFingerprint(file: File): Promise<string> {
  const size = file.size;
  const first = await file.slice(0, Math.min(SAMPLE_BYTES, size)).arrayBuffer();
  const last = size > SAMPLE_BYTES ? await file.slice(Math.max(0, size - SAMPLE_BYTES), size).arrayBuffer() : first;
  const joined = new Uint8Array(first.byteLength + last.byteLength);
  joined.set(new Uint8Array(first));
  joined.set(new Uint8Array(last), first.byteLength);
  return size + ':' + await sha256Bytes(joined.buffer);
}

function categoryFor(file: File, name: string): FileCategory {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('video/')) return 'video';
  if (file.type.startsWith('audio/')) return 'audio';
  if (file.type.includes('sheet') || /\.(csv|xls|xlsx)$/i.test(name)) return 'spreadsheet';
  if (file.type.includes('pdf') || /\.(pdf|doc|docx|txt|rtf)$/i.test(name)) return 'document';
  if (/\.(zip|rar|7z)$/i.test(name)) return 'archive';
  return 'other';
}

async function scanDirectoryBatched(
  root: DirHandle,
  source: StorageSource,
  onBatch: (batch: PickedEntry[]) => void | Promise<void>,
  signal?: AbortSignal
): Promise<number> {
  let batch: PickedEntry[] = [];
  let count = 0;
  const flush = async () => {
    if (!batch.length) return;
    const current = batch;
    batch = [];
    await onBatch(current);
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  };
  const walk = async (dir: DirHandle, prefix: string): Promise<void> => {
    for await (const [name, entry] of dir.entries()) {
      if (signal?.aborted) throw new DOMException('Scan aborted', 'AbortError');
      if (name.startsWith('.') || name === 'Duplicates-Review') continue;
      if (entry.kind === 'directory') {
        await walk(entry, prefix ? prefix + '/' + name : name);
        continue;
      }
      const file = await entry.getFile();
      batch.push({
        id: source + ':' + (prefix ? prefix + '/' : '') + name,
        name,
        path: prefix ? prefix + '/' + name : name,
        source,
        size: file.size,
        modifiedTime: new Date(file.lastModified).toISOString(),
        mimeType: file.type || 'application/octet-stream',
        category: categoryFor(file, name),
        fastFingerprint: await fastFingerprint(file),
        fileHandle: entry,
        parentHandle: dir,
        isDuplicate: false,
        verified: false,
      });
      count++;
      if (batch.length >= BATCH_SIZE) await flush();
    }
  };
  await walk(root, '');
  await flush();
  return count;
}

async function fullHashCandidates(entries: PickedEntry[], onProgress?: (done: number, total: number) => void): Promise<PickedEntry[]> {
  const groups = new Map<string, PickedEntry[]>();
  for (const entry of entries) {
    const list = groups.get(entry.fastFingerprint) || [];
    list.push(entry);
    groups.set(entry.fastFingerprint, list);
  }
  const candidates = [...groups.values()].filter(group => group.length > 1).flat();
  let done = 0;
  for (const entry of candidates) {
    if (!entry.fileHandle) continue;
    const file = await entry.fileHandle.getFile();
    entry.contentHash = 'sha256:' + await sha256Bytes(await file.arrayBuffer());
    entry.verified = true;
    done++;
    onProgress?.(done, candidates.length);
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  return entries;
}

function duplicateIds(entries: PickedEntry[]): Set<string> {
  const groups = new Map<string, PickedEntry[]>();
  for (const entry of entries) {
    const key = entry.contentHash || 'fast:' + entry.fastFingerprint;
    const list = groups.get(key) || [];
    list.push(entry);
    groups.set(key, list);
  }
  const ids = new Set<string>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const verifiedGroup = group.every(entry => entry.verified && entry.contentHash);
    if (verifiedGroup) group.forEach(entry => ids.add(entry.id));
    else group.slice(1).forEach(entry => ids.add(entry.id));
  }
  return ids;
}

interface Props { onSelectPreviewFile?: (file: DriveFile) => void; }

export const DeviceStorageScanner: React.FC<Props> = ({ onSelectPreviewFile }) => {
  const demo = useMemo(() => MOCK_DEVICE_FILES.map(f => ({
    id: f.id, name: f.name, path: f.path, source: f.source, size: f.size, modifiedTime: f.lastModified,
    mimeType: f.mimeType, category: f.category, fastFingerprint: 'demo:' + f.size + ':' + f.name.toLowerCase(),
    isDuplicate: Boolean(f.isDuplicate), verified: false,
  })), []);
  const [files, setFiles] = useState<PickedEntry[]>(demo);
  const [roots, setRoots] = useState<Partial<Record<StorageSource, DirHandle>>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [source, setSource] = useState<'all' | StorageSource>('all');
  const [query, setQuery] = useState('');
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [moveName, setMoveName] = useState('Duplicates-Review');
  const [confirmMove, setConfirmMove] = useState(false);
  const [hashProgress, setHashProgress] = useState<{ done: number; total: number } | null>(null);

  const show = (m: string) => { setMessage(m); window.setTimeout(() => setMessage(null), 5000); };

  const duplicates = useMemo(() => duplicateIds(files), [files]);
  const visible = useMemo(() => files
    .filter(f => source === 'all' || f.source === source)
    .filter(f => !query.trim() || (f.name + ' ' + f.path).toLowerCase().includes(query.toLowerCase().trim()))
    .map(f => ({ ...f, isDuplicate: duplicates.has(f.id) })), [files, source, query, duplicates]);

  const selectRoot = async (which: StorageSource) => {
    const picker = (window as PickerWindow).showDirectoryPicker;
    if (!picker) { show('इस browser में folder access उपलब्ध नहीं है। Chrome Android में HTTPS पर app खोलें।'); return; }
    try {
      const root = await picker({ id: which, mode: 'readwrite' });
      if (!(await permission(root, 'readwrite'))) { show('Write permission नहीं मिली; कोई बदलाव नहीं किया गया।'); return; }
      setRoots(p => ({ ...p, [which]: root }));
      setScanning(true);
      setHashProgress(null);
      const candidateBuckets = new Map<string, PickedEntry[]>();
      let scannedCount = 0;
      await scanDirectoryBatched(root, which, batch => {
        scannedCount += batch.length;
        for (const entry of batch) {
          const list = candidateBuckets.get(entry.fastFingerprint) || [];
          list.push(entry);
          candidateBuckets.set(entry.fastFingerprint, list);
        }
        setFiles(prev => [...prev.filter(f => f.source !== which), ...batch]);
      });
      setHashProgress({ done: 0, total: 0 });
      const candidates = [...candidateBuckets.values()].filter(group => group.length > 1).flat();
      await fullHashCandidates(candidates, (done, candidateTotal) => {
        setHashProgress({ done, total: candidateTotal });
        if (done % 4 === 0 || done === candidateTotal) {
          setFiles(prev => prev.map(entry => {
            const updated = candidates.find(candidate => candidate.id === entry.id);
            return updated || entry;
          }));
        }
      });
      setFiles(prev => prev.map(entry => {
        const updated = candidates.find(candidate => candidate.id === entry.id);
        return updated || entry;
      }));
      setSelected(new Set());
      setScanning(false);
      setHashProgress(null);
      show((which === 'phone_internal' ? 'Phone storage' : 'SD card') + ': ' + scannedCount + ' files scanned in batches. Candidate groups were full SHA-256 verified. Nothing was deleted.');
    } catch (e) {
      setScanning(false);
      setHashProgress(null);
      if ((e as DOMException)?.name !== 'AbortError') show('Storage scan failed: ' + (e instanceof Error ? e.message : 'permission denied'));
    }
  };

  const asDriveFile = (f: PickedEntry): DriveFile => ({
    id: 'device-preview-' + f.id, name: f.name, mimeType: f.mimeType, size: f.size,
    modifiedTime: f.modifiedTime, createdTime: f.modifiedTime, category: f.category,
    isOffline: false, isEncrypted: false, contentHash: f.contentHash || 'fast:' + f.fastFingerprint,
    tags: [f.source, f.category, f.verified ? 'sha256-verified' : 'fast-fingerprint'],
    semanticSummary: 'Selected local file: ' + f.path, starred: false,
  });

  const selectedEntries = visible.filter(f => selected.has(f.id));
  const duplicateSelected = selectedEntries.filter(f => f.isDuplicate);

  const moveSelected = async () => {
    setConfirmMove(false);
    setBusy(true);
    try {
      const byRoot = new Map<StorageSource, PickedEntry[]>();
      for (const f of duplicateSelected) {
        const list = byRoot.get(f.source) || [];
        list.push(f);
        byRoot.set(f.source, list);
      }
      let moved = 0;
      for (const [src, list] of byRoot) {
        const root = roots[src];
        if (!root || !(await permission(root, 'readwrite'))) continue;
        const target = await root.getDirectoryHandle(moveName.trim() || 'Duplicates-Review', { create: true });
        for (const f of list) {
          if (!f.fileHandle || !f.parentHandle) continue;
          const file = await f.fileHandle.getFile();
          const ext = f.name.includes('.') ? f.name.slice(f.name.lastIndexOf('.')) : '';
          const stem = ext ? f.name.slice(0, -ext.length) : f.name;
          let targetName = f.name;
          let suffix = 1;
          while (true) {
            try { await target.getFileHandle(targetName); targetName = stem + ' (duplicate ' + suffix + ')' + ext; suffix++; }
            catch { break; }
          }
          const out = await target.getFileHandle(targetName, { create: true });
          const writable = await out.createWritable();
          await writable.write(file);
          await writable.close();
          await f.parentHandle.removeEntry(f.name);
          moved++;
        }
      }
      setFiles(p => p.filter(f => !duplicateSelected.some(d => d.id === f.id)));
      setSelected(new Set());
      show(moved + ' verified duplicate file(s) moved to "' + (moveName.trim() || 'Duplicates-Review') + '". Source was removed only after successful copy. No delete/trash API exists.');
    } catch (e) {
      show('Move stopped safely: ' + (e instanceof Error ? e.message : 'unknown error'));
    } finally { setBusy(false); }
  };

  const toggle = (id: string) => setSelected(p => {
    const next = new Set(p); if (next.has(id)) next.delete(id); else next.add(id); return next;
  });

  return <div className="space-y-5">
    {message && <div className="fixed top-20 right-4 z-50 rounded-xl bg-zinc-900 text-white px-4 py-3 text-xs shadow-xl flex gap-2 items-center"><CheckCircle2 className="w-4 h-4 text-emerald-400"/><span>{message}</span><button onClick={() => setMessage(null)}><X className="w-4 h-4"/></button></div>}
    <section className="rounded-2xl border border-amber-200 bg-amber-50 dark:bg-amber-950/20 p-4 space-y-3">
      <div className="flex items-start gap-3"><ShieldCheck className="w-5 h-5 text-amber-600 shrink-0"/><div>
        <h2 className="font-bold">Safe Storage Cleaner</h2>
        <p className="text-xs text-zinc-600 dark:text-zinc-400">यह cleaner कोई local file delete नहीं करता। पहले folder access, फिर Move की अंतिम पुष्टि आवश्यक है। Full SHA-256 केवल fast-fingerprint से मिले candidate groups पर चलता है; पूरे storage को full-hash नहीं किया जाता।</p>
      </div></div>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => selectRoot('phone_internal')} disabled={scanning || busy} className="px-3 py-2 rounded-xl bg-blue-600 text-white text-xs font-bold inline-flex gap-1.5 items-center"><FolderOpen className="w-4 h-4"/> Phone storage चुनें</button>
        <button type="button" onClick={() => selectRoot('sd_card')} disabled={scanning || busy} className="px-3 py-2 rounded-xl bg-indigo-600 text-white text-xs font-bold inline-flex gap-1.5 items-center"><FolderOpen className="w-4 h-4"/> SD card चुनें</button>
      </div>
      <p className="text-[11px] text-zinc-500">Picker में Phone internal storage या SD card का root/वांछित folder स्वयं चुनें।</p>
    </section>
    <div className="flex flex-wrap gap-2">
      <input value={query} onChange={e => setQuery(e.target.value)} placeholder="फ़ाइल नाम खोजें..." className="flex-1 min-w-[160px] px-3 py-2 rounded-xl border text-sm"/>
      <select value={source} onChange={e => setSource(e.target.value as 'all' | StorageSource)} className="px-3 py-2 rounded-xl border text-xs"><option value="all">Phone + SD</option><option value="phone_internal">Phone</option><option value="sd_card">SD</option></select>
      <button type="button" onClick={() => setSelected(new Set(visible.filter(f => f.isDuplicate).map(f => f.id)))} className="px-3 py-2 rounded-xl border text-xs font-semibold">Select duplicates</button>
    </div>
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="font-semibold">{visible.length} files • {visible.filter(f => f.isDuplicate).length} duplicate candidates • {duplicateSelected.length} selected</span>
      {duplicateSelected.length > 0 && <>
        <input value={moveName} onChange={e => setMoveName(e.target.value)} className="w-40 px-2 py-1.5 rounded-lg border" aria-label="new folder name"/>
        <button type="button" disabled={busy} onClick={() => setConfirmMove(true)} className="px-3 py-1.5 rounded-lg bg-emerald-600 text-white font-bold">Move selected to new folder</button>
      </>}
    </div>
    {scanning && <div className="flex items-center gap-2 text-xs text-blue-600"><Loader2 className="w-4 h-4 animate-spin"/>Storage scan चल रहा है… batches में files पढ़ी जा रही हैं।</div>}
    {hashProgress && hashProgress.total > 0 && <div className="text-xs text-indigo-600">Candidate SHA-256 verification: {hashProgress.done}/{hashProgress.total}</div>}
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
      {visible.slice(0, 500).map(f => <div key={f.id} className="rounded-xl border p-3 bg-white dark:bg-zinc-900 flex items-start gap-2">
        <button type="button" onClick={() => toggle(f.id)}>{selected.has(f.id) ? <CheckSquare className="w-4 h-4 text-blue-600"/> : <Square className="w-4 h-4 text-zinc-400"/>}</button>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold truncate">{f.name}</div>
          <div className="text-[10px] text-zinc-500">{formatBytes(f.size)} • {f.source === 'sd_card' ? 'SD' : 'Phone'} • {f.path}</div>
          {f.isDuplicate && <span className="text-[10px] text-amber-700 font-bold">{f.verified ? 'Exact duplicate · SHA-256 verified' : 'Duplicate candidate'}</span>}
        </div>
        {onSelectPreviewFile && <button type="button" onClick={() => onSelectPreviewFile(asDriveFile(f))} className="px-2 py-1 rounded-lg border text-[10px]">Details</button>}
      </div>)}
    </div>
    {visible.length > 500 && <p className="text-center text-xs text-zinc-500">Showing first 500.</p>}
    {visible.length === 0 && <p className="text-center py-8 text-sm text-zinc-500">पहले Phone storage या SD card चुनें।</p>}
    {confirmMove && <div className="fixed inset-0 z-[70] bg-black/60 flex items-center justify-center p-4"><div className="w-full max-w-md rounded-2xl bg-white dark:bg-zinc-900 p-5 space-y-4 shadow-2xl">
      <h3 className="font-bold">Move की अंतिम अनुमति</h3>
      <p className="text-sm">आप {duplicateSelected.length} verified duplicate candidate files को नए folder में move करने वाले हैं। पहले copy पूरी होगी; source केवल सफल copy के बाद हटेगा। कोई Delete/Trash action उपलब्ध नहीं है।</p>
      <div className="flex justify-end gap-2"><button type="button" onClick={() => setConfirmMove(false)} className="px-3 py-2 rounded-lg border">Cancel</button><button type="button" onClick={() => void moveSelected()} className="px-3 py-2 rounded-lg bg-emerald-600 text-white font-bold">हाँ, Move करें</button></div>
    </div></div>}
  </div>;
};
