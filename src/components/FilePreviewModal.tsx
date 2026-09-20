import React, { useEffect, useState } from 'react';
import {
  X,
  Download,
  HardDrive,
  FileText,
  Tag,
  Calendar,
  ExternalLink,
  Check,
  FolderInput,
} from 'lucide-react';
import { DriveFile } from '../types';
import { formatBytes } from '../lib/driveApi';
import { getOfflineBlob } from '../lib/offlineCache';

interface FilePreviewModalProps {
  file: DriveFile | null;
  onClose: () => void;
  onToggleOffline: (id: string) => void;
  onMove?: (file: DriveFile) => void;
}

export const FilePreviewModal: React.FC<FilePreviewModalProps> = ({
  file,
  onClose,
  onToggleOffline,
  onMove,
}) => {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [blobMime, setBlobMime] = useState<string>('');
  const [blobLoading, setBlobLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let url: string | null = null;

    (async () => {
      if (!file?.isOffline) {
        setBlobUrl(null);
        return;
      }
      setBlobLoading(true);
      try {
        const blob = await getOfflineBlob(file.id);
        if (cancelled || !blob) {
          setBlobUrl(null);
          return;
        }
        url = URL.createObjectURL(blob);
        if (!cancelled) {
          setBlobUrl(url);
          setBlobMime(blob.type || file.mimeType || '');
        }
      } catch {
        if (!cancelled) setBlobUrl(null);
      } finally {
        if (!cancelled) setBlobLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [file?.id, file?.isOffline, file?.mimeType]);

  if (!file) return null;

  const handleDownloadCached = () => {
    if (!blobUrl) return;
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = file.name;
    a.click();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-lg bg-white dark:bg-zinc-900 rounded-3xl border border-zinc-200 dark:border-zinc-800 shadow-2xl overflow-hidden max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-zinc-100 dark:border-zinc-800">
          <div className="flex items-center gap-2 min-w-0">
            <FileText className="w-5 h-5 text-blue-600 shrink-0" />
            <span className="font-bold text-sm truncate">{file.name}</span>
          </div>
          <button type="button" onClick={onClose} className="p-1 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-3 overflow-y-auto flex-1">
          <div className="text-xs text-zinc-500 flex flex-wrap gap-3">
            <span>{formatBytes(file.size)}</span>
            <span className="inline-flex items-center gap-1"><Calendar className="w-3 h-3" />{new Date(file.modifiedTime).toLocaleString()}</span>
            {file.isGoogleDriveItem && <span className="text-blue-600 font-semibold">Drive</span>}
          </div>

          {blobLoading && <p className="text-xs text-zinc-500 text-center py-6">Loading offline cache…</p>}

          {blobUrl && blobMime.startsWith('image/') && (
            <img src={blobUrl} alt={file.name} className="max-h-64 mx-auto rounded-xl" />
          )}

          {blobUrl && blobMime.startsWith('text/') && (
            <iframe src={blobUrl} title="preview" className="w-full h-48 rounded-xl border" />
          )}

          {!blobUrl && !blobLoading && (
            <p className="text-sm text-zinc-600 dark:text-zinc-400">{file.semanticSummary}</p>
          )}

          {(file.tags || []).length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {(file.tags || []).map(t => (
                <span
                  key={t}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-zinc-100 dark:bg-zinc-800 text-[10px] font-medium text-zinc-600 dark:text-zinc-300"
                >
                  <Tag className="w-2.5 h-2.5" />
                  {t}
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="px-5 py-3.5 border-t border-zinc-100 dark:border-zinc-800 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => onToggleOffline(file.id)}
            className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold min-h-[40px] border ${
              file.isOffline
                ? 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/30 dark:text-emerald-300 dark:border-emerald-900'
                : 'bg-white dark:bg-zinc-800 border-zinc-200 dark:border-zinc-700'
            }`}
          >
            {file.isOffline ? <Check className="w-3.5 h-3.5" /> : <HardDrive className="w-3.5 h-3.5" />}
            {file.isOffline ? 'Cached (Unpin)' : 'Pin offline'}
          </button>

          {onMove && (
            <button
              type="button"
              onClick={() => onMove(file)}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold min-h-[40px] border border-indigo-200 dark:border-indigo-800 text-indigo-700 dark:text-indigo-300 bg-indigo-50 dark:bg-indigo-950/30"
            >
              <FolderInput className="w-3.5 h-3.5" />
              Move to folder
            </button>
          )}

          {blobUrl && (
            <button
              type="button"
              onClick={handleDownloadCached}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold min-h-[40px] border border-zinc-200 dark:border-zinc-700"
            >
              <Download className="w-3.5 h-3.5" />
              Download cache
            </button>
          )}

          {file.webViewLink && (
            <a
              href={file.webViewLink}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold min-h-[40px] bg-blue-600 text-white"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              Open in Drive
            </a>
          )}
        </div>
      </div>
    </div>
  );
};
