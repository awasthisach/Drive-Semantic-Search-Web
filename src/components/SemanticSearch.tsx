import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  Search, Sparkles, Loader2, Database, FolderInput, Star, Pin, Link2,
} from 'lucide-react';
import { DriveFile, FolderItem, SemanticSearchResult } from '../types';
import { runHybridSearch } from '../lib/searchEngine';
import { canExtractText, extractDriveFileTextWithTimeout, ExtractAbortedError } from '../lib/contentExtract';
import {
  putIndexedDocument,
  listIndexedDocuments,
  getIndexedDocument,
  isDocumentStale,
  MAX_INDEX_CHARS,
  buildEmbeddingChunks,
} from '../lib/contentIndex';
import { highlightSegments } from '../lib/searchHighlight';
import { embedAndStoreChunks, hasCompatibleVectorSet, warmAnnIndex } from '../lib/vectorIndex';
import { isEmbedConfigured } from '../lib/embeddings/config';
import { createEmbeddingProvider } from '../lib/embeddings/client';
import { getFirebaseIdToken } from '../lib/firebaseAuth';
import { paginateResults } from '../lib/pagination';

interface SemanticSearchProps {
  files: DriveFile[];
  folders: FolderItem[];
  onSelectFile: (file: DriveFile) => void;
  onMoveFile: (file: DriveFile) => void;
  onToggleStar: (id: string) => void;
  onToggleOffline: (id: string) => void;
  accessToken: string | null;
  onRequestToken?: () => Promise<string | null>;
  corpusKey: string;
}

/** Keep screen awake while indexing so mobile browsers are less likely to throttle extract. */
async function acquireScreenWakeLock(): Promise<WakeLockSentinel | null> {
  try {
    if (typeof navigator === 'undefined' || !('wakeLock' in navigator)) return null;
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return null;
    return await navigator.wakeLock.request('screen');
  } catch (e) {
    console.warn('[SemanticSearch] Screen Wake Lock unavailable', e);
    return null;
  }
}

export const SemanticSearch: React.FC<SemanticSearchProps> = ({
  files,
  folders,
  onSelectFile,
  onMoveFile,
  onToggleStar,
  onToggleOffline,
  accessToken,
  onRequestToken,
  corpusKey,
}) => {
  const [query, setQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [results, setResults] = useState<SemanticSearchResult[]>([]);
  const [currentPage, setCurrentPage] = useState(1);
  const [searching, setSearching] = useState(false);
  const [indexedCount, setIndexedCount] = useState(0);
  const [indexing, setIndexing] = useState(false);
  const [indexProgress, setIndexProgress] = useState('');
  const [searchStatus, setSearchStatus] = useState('');
  const [resumeFrom, setResumeFrom] = useState(0);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const cancelIndexRef = useRef(false);
  const indexAbortRef = useRef<AbortController | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const indexingActiveRef = useRef(false);
  const paginatedResults = useMemo(
    () => paginateResults(results, currentPage),
    [results, currentPage]
  );
  const CURSOR_KEY = 'content-index-cursor';

  const releaseWakeLock = useCallback(async () => {
    const lock = wakeLockRef.current;
    wakeLockRef.current = null;
    if (!lock) return;
    try {
      await lock.release();
    } catch {
      /* ignore */
    }
  }, []);

  const requestWakeLock = useCallback(async () => {
    await releaseWakeLock();
    const lock = await acquireScreenWakeLock();
    wakeLockRef.current = lock;
    return Boolean(lock);
  }, [releaseWakeLock]);

  // Re-acquire wake lock when user returns to the tab during an active index run.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible' && indexingActiveRef.current) {
        void requestWakeLock();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      void releaseWakeLock();
    };
  }, [requestWakeLock, releaseWakeLock]);

  const buildIndexSignature = async (
    corpus: string,
    extractable: DriveFile[]
  ): Promise<string> => {
    const payload =
      corpus +
      '|' +
      extractable
        .map(f => f.id + ':' + (f.modifiedTime || ''))
        .sort()
        .join('|');
    try {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
      return Array.from(new Uint8Array(buf))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
    } catch {
      return corpus + ':' + String(extractable.length) + ':' + payload.length;
    }
  };
  const readCursor = (sig: string, n: number): number => {
    try {
      const raw = sessionStorage.getItem(CURSOR_KEY);
      if (!raw) return 0;
      const [storedSig, idx] = raw.split('|');
      if (storedSig !== sig) return 0;
      return Math.max(0, Math.min(n, Number(idx) || 0));
    } catch {
      return 0;
    }
  };
  const writeCursor = (sig: string, i: number) => {
    try {
      sessionStorage.setItem(CURSOR_KEY, sig + '|' + String(i));
    } catch { /* ignore */ }
  };
  const clearCursor = () => {
    try { sessionStorage.removeItem(CURSOR_KEY); } catch { /* ignore */ }
  };

  const copyLink = async (file: DriveFile) => {
    const link =
      file.webViewLink ||
      (file.isGoogleDriveItem ? 'https://drive.google.com/file/d/' + file.id + '/view' : '');
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopiedId(file.id);
      window.setTimeout(() => setCopiedId(prev => (prev === file.id ? null : prev)), 1600);
    } catch {
      setCopiedId(null);
    }
  };

  const refreshIndexedCount = useCallback(async () => {
    const docs = await listIndexedDocuments(corpusKey);
    setIndexedCount(docs.length);
  }, [corpusKey]);

  useEffect(() => {
    refreshIndexedCount();
    try {
      const raw = sessionStorage.getItem(CURSOR_KEY);
      if (!raw) setResumeFrom(0);
      else {
        const parts = raw.split('|');
        const idx = Number(parts[1] || 0) || 0;
        setResumeFrom(idx);
      }
    } catch { setResumeFrom(0); }
  }, [refreshIndexedCount]);

  useEffect(() => {
    if (indexedCount <= 128) return;
    let cancelled = false;
    const run = () => {
      if (!cancelled) void warmAnnIndex(corpusKey);
    };
    const idle = 'requestIdleCallback' in window
      ? (window as Window & { requestIdleCallback: (cb: () => void, opts?: { timeout: number }) => number })
          .requestIdleCallback(run, { timeout: 1500 })
      : globalThis.setTimeout(run, 250);
    return () => {
      cancelled = true;
      if (typeof idle === 'number' && 'cancelIdleCallback' in window) {
        (window as any).cancelIdleCallback(idle);
      } else {
        globalThis.clearTimeout(idle as any);
      }
    };
  }, [indexedCount, corpusKey]);

  const handleIndexContent = async () => {
    let token = accessToken || null;
    if (!token && onRequestToken) token = await onRequestToken();
    if (!token) {
      setIndexProgress('Sign in required to extract Drive content');
      return;
    }

    const extractable = files.filter(
      f => f.isGoogleDriveItem && canExtractText(f.mimeType, f.name)
    );
    if (!extractable.length) {
      setIndexProgress('No text-extractable Drive files in current list');
      return;
    }

    cancelIndexRef.current = false;
    indexAbortRef.current?.abort();
    const indexController = new AbortController();
    indexAbortRef.current = indexController;
    indexingActiveRef.current = true;
    setIndexing(true);

    const wakeOk = await requestWakeLock();
    if (wakeOk) {
      setIndexProgress('Screen stay-awake on. Preparing…');
    } else {
      setIndexProgress('Preparing… (keep this tab open; screen may sleep)');
    }

    let ok = 0;
    let fail = 0;
    let embeddingFail = 0;
    let skippedFresh = 0;
    let truncated = 0;
    const failedNames: string[] = [];
    const n = extractable.length;
    const embeddingProvider = isEmbedConfigured()
      ? createEmbeddingProvider(() => getFirebaseIdToken())
      : null;
    const sig = await buildIndexSignature(corpusKey, extractable);
    let startAt = readCursor(sig, n);
    if (startAt > 0) {
      setIndexProgress(`Resuming from ${startAt + 1}/${n}…`);
    }

    try {
      for (let i = startAt; i < extractable.length; i++) {
        if (cancelIndexRef.current) {
          setIndexProgress(
            `Cancelled after ${i}/${extractable.length}. Indexed: ${ok}, skipped fresh: ${skippedFresh}, failed: ${fail}.` +
              (failedNames.length
                ? ` Failed: ${failedNames.join(', ')}${fail > failedNames.length ? '…' : ''}`
                : '')
          );
          break;
        }

        const f = extractable[i];
        const pct = Math.round(((i + 1) / extractable.length) * 100);
        setIndexProgress(`Checking ${i + 1}/${extractable.length} (${pct}%): ${f.name}`);
        try {
          const existing = await getIndexedDocument(f.id);
          if (!isDocumentStale(existing, f.modifiedTime)) {
            if (embeddingProvider && existing?.text) {
              const chunks = buildEmbeddingChunks(existing.name || f.name, existing.text);
              const compatible = await hasCompatibleVectorSet({
                fileId: f.id,
                corpusKey,
                chunks,
                embeddingModel: embeddingProvider.embeddingModel,
                embeddingVersion: embeddingProvider.embeddingVersion,
                dimension: embeddingProvider.dimension,
              });
              if (!compatible) {
                setIndexProgress(`Migrating embeddings ${i + 1}/${extractable.length}: ${f.name}`);
                const migration = await embedAndStoreChunks({
                  provider: embeddingProvider,
                  fileId: f.id,
                  chunks,
                  corpusKey,
                  driveModifiedTime: f.modifiedTime,
                });
                if (migration.failed) {
                  fail++;
                  embeddingFail++;
                  if (failedNames.length < 5) failedNames.push(f.name);
                }
              }
            }
            skippedFresh++;
            writeCursor(sig, i + 1);
            continue;
          }

          setIndexProgress(`Extracting ${i + 1}/${extractable.length} (${pct}%): ${f.name}`);
          const { text, source, truncated: textWasTruncated } = await extractDriveFileTextWithTimeout(
            token,
            f.id,
            f.mimeType || '',
            f.name || '',
            { signal: indexController.signal }
          );

          if (cancelIndexRef.current || indexController.signal.aborted) {
            writeCursor(sig, i);
            setIndexProgress(`Cancelled at ${i}/${extractable.length}. Resume available.`);
            break;
          }

          if (!text || !text.trim()) {
            skippedFresh++;
            writeCursor(sig, i + 1);
            continue;
          }

          await putIndexedDocument({
            id: f.id,
            name: f.name,
            mimeType: f.mimeType || '',
            text: text.slice(0, MAX_INDEX_CHARS),
            source,
            driveModifiedTime: f.modifiedTime,
            textTruncated: textWasTruncated,
            corpusKey,
          });

          if (textWasTruncated) truncated++;

          if (embeddingProvider) {
            try {
              const chunks = buildEmbeddingChunks(f.name, text.slice(0, MAX_INDEX_CHARS));
              const embedding = await embedAndStoreChunks({
                provider: embeddingProvider,
                fileId: f.id,
                chunks,
                corpusKey,
                driveModifiedTime: f.modifiedTime,
              });
              if (embedding.failed) embeddingFail++;
            } catch (embedErr) {
              console.warn('[SemanticSearch] embed skipped for', f.name, embedErr);
              embeddingFail++;
            }
          }

          ok++;
          writeCursor(sig, i + 1);
        } catch (err: any) {
          if (
            err instanceof ExtractAbortedError ||
            err?.name === 'ExtractAbortedError' ||
            indexController.signal.aborted ||
            cancelIndexRef.current
          ) {
            writeCursor(sig, i);
            setIndexProgress(`Cancelled / timed out at ${i}/${extractable.length}. Resume available.`);
            break;
          }
          fail++;
          if (failedNames.length < 5) failedNames.push(f.name);
          console.warn('[SemanticSearch] index failed for', f.name, err);
          writeCursor(sig, i + 1);
        }
      }

      if (!cancelIndexRef.current && !indexController.signal.aborted) {
        clearCursor();
        setResumeFrom(0);
        setIndexProgress(
          `Done. Indexed ${ok}, skipped fresh ${skippedFresh}, failed ${fail}` +
            (embeddingFail ? `, embed fail ${embeddingFail}` : '') +
            (truncated ? `, truncated ${truncated}` : '') +
            (failedNames.length ? `. Failed: ${failedNames.join(', ')}` : '')
        );
      }
    } finally {
      indexingActiveRef.current = false;
      indexAbortRef.current = null;
      setIndexing(false);
      await releaseWakeLock();
      await refreshIndexedCount();
    }
  };

  useEffect(() => {
    let cancelled = false;
    const handle = window.setTimeout(async () => {
      if (!query.trim()) {
        setResults([]);
        setSearchStatus('');
        return;
      }
      setCurrentPage(1);
      setSearching(true);
      try {
        const r = await runHybridSearch(
          query,
          files,
          selectedCategory,
          corpusKey,
          setSearchStatus
        );
        if (!cancelled) setResults(r);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [query, files, selectedCategory, corpusKey]);

  return (
    <div className="flex flex-col h-full gap-3 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-400" />
          <input
            className="w-full pl-9 pr-3 py-2 rounded-lg border bg-background text-sm"
            placeholder="Semantic search across indexed Drive content…"
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
        </div>
        <select
          className="text-sm border rounded-lg px-2 py-2 bg-background"
          value={selectedCategory}
          onChange={e => setSelectedCategory(e.target.value)}
        >
          <option value="all">All</option>
          <option value="google_drive">Google Drive</option>
          <option value="document">Documents</option>
          <option value="spreadsheet">Spreadsheets</option>
          <option value="presentation">Presentations</option>
          <option value="pdf">PDFs</option>
          <option value="image">Images</option>
        </select>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
        <Database className="w-3.5 h-3.5" />
        <span>{indexedCount} indexed</span>
        {indexing ? (
          <>
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            <span className="truncate max-w-[280px]">{indexProgress}</span>
            <button
              type="button"
              className="px-2 py-0.5 rounded border border-red-400 text-red-600 hover:bg-red-50"
              onClick={() => {
                cancelIndexRef.current = true;
                indexAbortRef.current?.abort();
                setIndexProgress('Cancelling…');
              }}
            >
              Cancel
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="px-2 py-0.5 rounded border hover:bg-zinc-100"
              onClick={handleIndexContent}
            >
              Index / Rebuild
            </button>
            {resumeFrom > 0 && (
              <button
                type="button"
                className="px-2 py-0.5 rounded border border-blue-400 text-blue-600 hover:bg-blue-50"
                onClick={handleIndexContent}
              >
                Resume from {resumeFrom}
              </button>
            )}
            {indexProgress && <span className="truncate max-w-[240px]">{indexProgress}</span>}
          </>
        )}
        {searchStatus && (
          <span className="ml-auto flex items-center gap-1">
            <Sparkles className="w-3.5 h-3.5" />
            {searchStatus}
          </span>
        )}
      </div>

      <div className="flex-1 overflow-auto space-y-2">
        {searching && (
          <div className="flex items-center gap-2 text-sm text-zinc-500 p-3">
            <Loader2 className="w-4 h-4 animate-spin" /> Searching…
          </div>
        )}
        {!searching && results.length === 0 && query.trim() && (
          <div className="text-sm text-zinc-500 p-3">No results.</div>
        )}
        {!searching &&
          paginatedResults.items.map(r => (
            <div
              key={r.file.id}
              className="border rounded-lg p-3 hover:bg-zinc-50 dark:hover:bg-zinc-900/40 cursor-pointer group"
              onClick={() => onSelectFile(r.file)}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-medium text-sm truncate">{r.file.name}</div>
                  <div className="text-xs text-zinc-500 mt-0.5">
                    score {r.score} · {r.relevanceReason}
                  </div>
                </div>
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    type="button"
                    title="Star"
                    onClick={e => {
                      e.stopPropagation();
                      onToggleStar(r.file.id);
                    }}
                  >
                    <Star className={`w-4 h-4 ${r.file.starred ? 'fill-yellow-400 text-yellow-500' : 'text-zinc-400'}`} />
                  </button>
                  <button type="button" title="Pin offline" onClick={e => { e.stopPropagation(); onToggleOffline(r.file.id); }}>
                    <Pin className={`w-4 h-4 ${r.file.isOffline ? 'text-emerald-500' : 'text-zinc-400'}`} />
                  </button>
                  <button type="button" title="Copy link" onClick={e => { e.stopPropagation(); void copyLink(r.file); }}>
                    <Link2 className={`w-4 h-4 ${copiedId === r.file.id ? 'text-blue-500' : 'text-zinc-400'}`} />
                  </button>
                  <button type="button" title="Move" onClick={e => { e.stopPropagation(); onMoveFile(r.file); }}>
                    <FolderInput className="w-4 h-4 text-indigo-500" />
                  </button>
                </div>
              </div>
              {r.matchedSnippet && (
                <p className="text-[11px] text-zinc-600 dark:text-zinc-400 leading-relaxed mt-1">
                  {highlightSegments(r.matchedSnippet || '', query).map((seg, i) =>
                    seg.match ? (
                      <mark key={i} className="bg-amber-200/80 dark:bg-amber-500/30 rounded px-0.5">{seg.text}</mark>
                    ) : (
                      <span key={i}>{seg.text}</span>
                    )
                  )}
                </p>
              )}
            </div>
          ))}

        {!searching && paginatedResults.total > 0 && paginatedResults.pageCount > 1 && (
          <div className="flex flex-wrap items-center justify-between gap-2 pt-2 text-xs text-zinc-500">
            <span>
              Showing {paginatedResults.start}–{paginatedResults.end} of {paginatedResults.total}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={paginatedResults.page === 1}
                onClick={() => setCurrentPage(page => Math.max(1, page - 1))}
                className="rounded-lg border px-2.5 py-1.5 font-semibold disabled:opacity-40"
              >
                Previous
              </button>
              <span aria-live="polite">Page {paginatedResults.page} of {paginatedResults.pageCount}</span>
              <button
                type="button"
                disabled={paginatedResults.page === paginatedResults.pageCount}
                onClick={() => setCurrentPage(page => Math.min(paginatedResults.pageCount, page + 1))}
                className="rounded-lg border px-2.5 py-1.5 font-semibold disabled:opacity-40"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
