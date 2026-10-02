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
  const paginatedResults = useMemo(
    () => paginateResults(results, currentPage),
    [results, currentPage]
  );
  const CURSOR_KEY = 'content-index-cursor';

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

  const stopIndexing = useCallback(() => {
    cancelIndexRef.current = true;
    try {
      indexAbortRef.current?.abort();
    } catch { /* ignore */ }
    indexAbortRef.current = null;
    setIndexProgress('Cancelling…');
  }, []);

  const startIndexing = useCallback(async (opts?: { resume?: boolean }) => {
    if (indexing) return;
    if (!accessToken && !onRequestToken) {
      setIndexProgress('Sign in required to index Drive files.');
      return;
    }
    const extractable = files.filter(f => canExtractText(f.mimeType || '', f.name || ''));
    if (!extractable.length) {
      setIndexProgress('No extractable files in current view.');
      return;
    }

    cancelIndexRef.current = false;
    const controller = new AbortController();
    indexAbortRef.current = controller;
    setIndexing(true);
    setIndexProgress('Preparing…');

    let token = accessToken;
    if (!token && onRequestToken) {
      token = await onRequestToken();
    }
    if (!token) {
      setIndexing(false);
      setIndexProgress('Could not obtain access token.');
      return;
    }

    const sig = await buildIndexSignature(corpusKey, extractable);
    let startIdx = 0;
    if (opts?.resume) {
      startIdx = readCursor(sig, extractable.length);
    } else {
      clearCursor();
    }
    setResumeFrom(startIdx);

    let done = startIdx;
    let failed = 0;
    let skipped = 0;

    try {
      for (let i = startIdx; i < extractable.length; i++) {
        if (cancelIndexRef.current || controller.signal.aborted) {
          writeCursor(sig, i);
          setResumeFrom(i);
          setIndexProgress(`Cancelled at ${i}/${extractable.length}. Resume available.`);
          break;
        }

        const file = extractable[i];
        setIndexProgress(`Indexing ${i + 1}/${extractable.length}: ${file.name.slice(0, 48)}`);

        try {
          const existing = await getIndexedDocument(file.id, corpusKey);
          if (existing && !isDocumentStale(existing, file.modifiedTime || '')) {
            skipped++;
            done = i + 1;
            writeCursor(sig, done);
            continue;
          }

          const extracted = await extractDriveFileTextWithTimeout(
            token,
            file.id,
            file.mimeType || '',
            file.name || '',
            { signal: controller.signal }
          );

          if (cancelIndexRef.current || controller.signal.aborted) {
            writeCursor(sig, i);
            setResumeFrom(i);
            setIndexProgress(`Cancelled at ${i}/${extractable.length}. Resume available.`);
            break;
          }

          const text = (extracted.text || '').trim();
          if (!text) {
            skipped++;
            done = i + 1;
            writeCursor(sig, done);
            continue;
          }

          await putIndexedDocument({
            fileId: file.id,
            corpusKey,
            name: file.name,
            mimeType: file.mimeType || '',
            modifiedTime: file.modifiedTime || '',
            text: text.slice(0, MAX_INDEX_CHARS),
            source: extracted.source,
            note: extracted.note,
            truncated: extracted.truncated,
          });

          // Optional neural embed (best-effort; never block index)
          if (isEmbedConfigured()) {
            try {
              const chunks = buildEmbeddingChunks(text);
              if (chunks.length) {
                const provider = createEmbeddingProvider(() => getFirebaseIdToken());
                await embedAndStoreChunks(file.id, corpusKey, chunks, provider);
              }
            } catch (embedErr) {
              console.warn('[SemanticSearch] embed skipped for', file.name, embedErr);
            }
          }

          done = i + 1;
          writeCursor(sig, done);
        } catch (err) {
          if (err instanceof ExtractAbortedError || (err as any)?.name === 'ExtractAbortedError') {
            writeCursor(sig, i);
            setResumeFrom(i);
            setIndexProgress(`Cancelled / timed out at ${i}/${extractable.length}. Resume available.`);
            break;
          }
          failed++;
          console.warn('[SemanticSearch] index failed for', file.name, err);
          done = i + 1;
          writeCursor(sig, done);
        }
      }

      if (!cancelIndexRef.current && !controller.signal.aborted) {
        clearCursor();
        setResumeFrom(0);
        setIndexProgress(`Done. Indexed up to ${done}/${extractable.length} (skipped ${skipped}, failed ${failed}).`);
      }
    } finally {
      indexAbortRef.current = null;
      setIndexing(false);
      await refreshIndexedCount();
    }
  }, [indexing, accessToken, onRequestToken, files, corpusKey, refreshIndexedCount]);

  const runSearch = useCallback(async () => {
    if (!query.trim()) {
      setResults([]);
      setSearchStatus('');
      return;
    }
    setSearching(true);
    setSearchStatus('');
    setCurrentPage(1);
    try {
      const hits = await runHybridSearch(
        query,
        files,
        selectedCategory,
        corpusKey,
        (msg) => setSearchStatus(msg)
      );
      setResults(hits);
      if (!hits.length) setSearchStatus('No matches.');
    } catch (e) {
      console.warn('[SemanticSearch] search error', e);
      setSearchStatus('Search failed.');
      setResults([]);
    } finally {
      setSearching(false);
    }
  }, [query, files, selectedCategory, corpusKey]);

  useEffect(() => {
    const t = window.setTimeout(() => {
      void runSearch();
    }, 280);
    return () => window.clearTimeout(t);
  }, [runSearch]);

  return (
    <div className="flex flex-col h-full gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
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

      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Database className="w-3.5 h-3.5" />
        <span>{indexedCount} indexed</span>
        {indexing ? (
          <>
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            <span className="truncate max-w-[280px]">{indexProgress}</span>
            <button
              type="button"
              className="px-2 py-0.5 rounded border border-destructive/40 text-destructive hover:bg-destructive/10"
              onClick={stopIndexing}
            >
              Cancel
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="px-2 py-0.5 rounded border hover:bg-muted"
              onClick={() => void startIndexing({ resume: false })}
            >
              Index / Rebuild
            </button>
            {resumeFrom > 0 && (
              <button
                type="button"
                className="px-2 py-0.5 rounded border border-primary/40 text-primary hover:bg-primary/10"
                onClick={() => void startIndexing({ resume: true })}
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
          <div className="flex items-center gap-2 text-sm text-muted-foreground p-3">
            <Loader2 className="w-4 h-4 animate-spin" /> Searching…
          </div>
        )}
        {!searching && results.length === 0 && query.trim() && (
          <div className="text-sm text-muted-foreground p-3">No results.</div>
        )}
        {!searching &&
          paginatedResults.items.map(r => (
            <div
              key={r.file.id}
              className="border rounded-lg p-3 hover:bg-muted/40 cursor-pointer group"
              onClick={() => onSelectFile(r.file)}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-medium text-sm truncate">{r.file.name}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    score {r.score} · {r.relevanceReason}
                  </div>
                </div>
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    type="button"
                    className="p-1 rounded hover:bg-muted"
                    title="Star"
                    onClick={e => {
                      e.stopPropagation();
                      onToggleStar(r.file.id);
                    }}
                  >
                    <Star className={`w-3.5 h-3.5 ${r.file.starred ? 'fill-yellow-400 text-yellow-500' : ''}`} />
                  </button>
                  <button
                    type="button"
                    className="p-1 rounded hover:bg-muted"
                    title="Move"
                    onClick={e => {
                      e.stopPropagation();
                      onMoveFile(r.file);
                    }}
                  >
                    <FolderInput className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    className="p-1 rounded hover:bg-muted"
                    title="Copy link"
                    onClick={e => {
                      e.stopPropagation();
                      void copyLink(r.file);
                    }}
                  >
                    <Link2 className={`w-3.5 h-3.5 ${copiedId === r.file.id ? 'text-green-500' : ''}`} />
                  </button>
                </div>
              </div>
              {r.matchedSnippet && (
                <div className="text-xs mt-2 text-muted-foreground line-clamp-3">
                  {highlightSegments(r.matchedSnippet, query).map((seg, i) =>
                    seg.highlight ? (
                      <mark key={i} className="bg-yellow-200/80 dark:bg-yellow-900/50 rounded px-0.5">
                        {seg.text}
                      </mark>
                    ) : (
                      <span key={i}>{seg.text}</span>
                    )
                  )}
                </div>
              )}
            </div>
          ))}

        {paginatedResults.totalPages > 1 && (
          <div className="flex items-center justify-center gap-2 py-2">
            <button
              type="button"
              className="px-2 py-1 text-xs border rounded disabled:opacity-40"
              disabled={currentPage <= 1}
              onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
            >
              Prev
            </button>
            <span className="text-xs text-muted-foreground">
              {currentPage} / {paginatedResults.totalPages}
            </span>
            <button
              type="button"
              className="px-2 py-1 text-xs border rounded disabled:opacity-40"
              disabled={currentPage >= paginatedResults.totalPages}
              onClick={() => setCurrentPage(p => p + 1)}
            >
              Next
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
