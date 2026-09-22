import React, { useState, useEffect } from 'react';
import {
  HardDrive,
  Trash2,
  FileText,
} from 'lucide-react';
import { DriveFile } from '../types';
import { formatBytes } from '../lib/driveApi';

interface OfflineFilesListProps {
  files: DriveFile[];
  onToggleOffline: (fileId: string) => void;
  onSelectFile: (file: DriveFile) => void;
}

export const OfflineFilesList: React.FC<OfflineFilesListProps> = ({
  files,
  onToggleOffline,
  onSelectFile,
}) => {
  const offlineFiles = files.filter(f => f.isOffline);
  const totalCachedBytes = offlineFiles.reduce((sum, f) => sum + f.size, 0);
  const [est, setEst] = useState<{ usage?: number; quota?: number } | null>(null);
  useEffect(() => {
    let cancelled = false;
    navigator.storage?.estimate?.()
      .then(e => { if (!cancelled) setEst({ usage: e.usage, quota: e.quota }); })
      .catch(() => { if (!cancelled) setEst(null); });
    return () => { cancelled = true; };
  }, [offlineFiles.length]);
  const usageRatio = est?.usage != null && est?.quota && est.quota > 0 ? est.usage / est.quota : null;

  return (
    <div className="space-y-6">
      <div className="rounded-2xl p-5 sm:p-6 bg-gradient-to-br from-emerald-950/80 via-zinc-900 to-zinc-950 text-white border border-emerald-900/30 shadow-md">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-start sm:items-center gap-3.5">
            <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 shrink-0">
              <HardDrive className="w-6 h-6" />
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-lg sm:text-xl font-bold tracking-tight">Offline Pinned Storage</h2>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                  IndexedDB blobs
                </span>
              </div>
              <p className="text-xs sm:text-sm text-zinc-400 mt-1 max-w-xl">
                Pin from file preview. Binary files download as-is; Docs/Sheets/Slides export as PDF/XLSX.
              </p>
            </div>
          </div>
          <div className="text-left sm:text-right space-y-1">
            <p className="text-[11px] text-zinc-400 uppercase tracking-wider font-semibold">Listed size</p>
            <p className="text-base sm:text-xl font-bold text-emerald-400 font-mono">{formatBytes(totalCachedBytes)}</p>
            {est?.usage != null && est?.quota != null && est.quota > 0 && (
              <p className={`text-[11px] font-mono ${usageRatio != null && usageRatio > 0.8 ? 'text-amber-400' : 'text-zinc-400'}`}>
                Browser: {formatBytes(est.usage)} / {formatBytes(est.quota)}
                {usageRatio != null && usageRatio > 0.8 ? ' — high usage' : ''}
              </p>
            )}
          </div>
        </div>
      </div>

      {offlineFiles.length === 0 ? (
        <div className="text-center py-12 text-sm text-zinc-500 rounded-2xl border border-dashed border-zinc-300 dark:border-zinc-800">
          No pinned files. Open a Drive file and use Pin for Offline Access.
        </div>
      ) : (
        <div className="space-y-2">
          {offlineFiles.map(file => (
            <div
              key={file.id}
              className="flex items-center justify-between gap-3 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3"
            >
              <button type="button" className="flex items-center gap-3 min-w-0 text-left flex-1" onClick={() => onSelectFile(file)}>
                <div className="w-10 h-10 rounded-lg bg-emerald-50 dark:bg-emerald-950/40 text-emerald-600 flex items-center justify-center shrink-0">
                  <FileText className="w-5 h-5" />
                </div>
                <div className="min-w-0">
                  <div className="text-sm font-semibold truncate">{file.name}</div>
                  <div className="text-[11px] text-zinc-500">
                    {formatBytes(file.size)}
                    {file.contentHash?.startsWith('sha256:') ? ' · SHA-256' : ''}
                  </div>
                </div>
              </button>
              <button
                type="button"
                onClick={() => onToggleOffline(file.id)}
                className="px-2 py-1.5 rounded-lg border text-xs text-red-600 inline-flex items-center gap-1"
              >
                <Trash2 className="w-3.5 h-3.5" /> Unpin
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
