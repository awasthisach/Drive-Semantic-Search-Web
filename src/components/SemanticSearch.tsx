import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Search, Sparkles, Loader2, Database, FolderInput, Star, Pin, Link2,
} from 'lucide-react';
import { DriveFile, FolderItem, SemanticSearchResult } from '../types';
import { runHybridSearch } from '../lib/searchEngine';
import { canExtractText, extractDriveFileText } from '../lib/contentExtract';
import {
  putIndexedDocument,
  listIndexedDocuments,
  getIndexedDocument,
  isDocumentStale,
  MAX_INDEX_CHARS,
} from '../lib/contentIndex';
import { highlightSegments } from '../lib/searchHighlight';

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
  const [searching, setSearching] = useState(false);
  const [indexedCount, setIndexedCount] = useState(0);
  const [indexing, setIndexing] = useState(false);
  const [indexProgress, setIndexProgress] = useState('');
  const [resumeFrom, setResumeFrom] = useState(0);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const cancelIndexRef = useRef(false);
  const CURSOR_KEY = 'content-index-cursor';

  /** Invalidate resume offset when corpus or extractable set size changes. */
  const cursorSig = (corpus: string, n: number) => corpus + ':' + String(n);
  const readCursor = (corpus: string, n: number): number => {
    try {
      const raw = sessionStorage.getItem(CURSOR_KEY);
      if (!raw) return 0;
      const [sig, idx] = raw.split('|');
      if (sig !== cursorSig(corpus, n)) return 0;
      return Math.max(0, Math.min(n, Number(idx) || 0));
    } catch {
      return 0;
    }
  };
  const writeCursor = (corpus: string, n: number, i: number) => {
    try {
      sessionStorage.setItem(CURSOR_KEY, cursorSig(corpus, n) + '|' + String(i));
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
    const docs = await listIndexedDocuments();
    setIndexedCount(docs.length);
  }, []);

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
    let cancelled = false;
    const handle = window.setTimeout(async () => {
      setSearching(true);
      try {
        const r = await runHybridSearch(query, files, selectedCategory);
        if (!cancelled) setResults(r);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [query, files, selectedCategory]);

  const driveFilesCount = files.filter(f => f.isGoogleDriveItem).length;

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
    setIndexing(true);
    let ok = 0;
    let fail = 0;
    let skippedFresh = 0;
    let truncated = 0;
    const failedNames: string[] = [];
    const n = extractable.length;
    let startAt = readCursor(corpusKey, n);
    if (startAt > 0) {
      setIndexProgress(`Resuming from ${startAt + 1}/${n}\u2026`);
    }

    for (let i = startAt; i < extractable.length; i++) {
      if (cancelIndexRef.current) {
        setIndexProgress(
          `Cancelled after ${i}/${extractable.length}. Indexed: ${ok}, skipped fresh: ${skippedFresh}, failed: ${fail}.` +
            (failedNames.length
              ? ` Failed: ${failedNames.join(', ')}${fail > failedNames.length ? '\u2026' : ''}`
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
          skippedFresh++;
          writeCursor(corpusKey, extractable.length, i + 1);
          continue;
        }
        setIndexProgress(`Indexing ${i + 1}/${extractable.length} (${pct}%): ${f.name}`);
        const { text, source } = await extractDriveFileText(token, f.id, f.mimeType, f.name);
        if (text && text.trim().length > 0) {
          const wasTrunc = text.length > MAX_INDEX_CHARS;
          await putIndexedDocument({
            id: f.id,
            name: f.name,
            mimeType: f.mimeType,
            text: text.slice(0, MAX_INDEX_CHARS),
            source,
            driveModifiedTime: f.modifiedTime,
            textTruncated: wasTrunc,
            corpusKey,
          });
          ok++;
          if (wasTrunc) truncated++;
          writeCursor(corpusKey, extractable.length, i + 1);
        } else {
          fail++;
          if (failedNames.length < 20) failedNames.push(f.name);
        }
      } catch {
        fail++;
        if (failedNames.length < 20) failedNames.push(f.name);
      }
      await new Promise(r => setTimeout(r, 100));
    }

    if (!cancelIndexRef.current) {
      clearCursor();
      setIndexProgress(
        `Done: ${ok} indexed, ${skippedFresh} already fresh, ${fail} failed` +
          (truncated ? `, ${truncated} truncated` : '') +
          (failedNames.length
            ? `. Failed: ${failedNames.join(', ')}${fail > failedNames.length ? '\u2026' : ''}`
            : '.')
      );
    }
    setIndexing(false);
    try {
      const raw = sessionStorage.getItem(CURSOR_KEY);
      setResumeFrom(raw ? (Number(raw.split('|')[1] || 0) || 0) : 0);
    } catch { setResumeFrom(0); }
    await refreshIndexedCount();
  };

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-indigo-500" />
          <h2 className="text-sm font-bold">Hybrid search</h2>
          <span className="text-[10px] text-zinc-500">metadata + BM25 body</span>
        </div>
        <div className="flex flex-wrap gap-2">
          <div className="relative flex-1 min-w-[180px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-400" />
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search files and indexed content\u2026"
              className="w-full pl-9 pr-3 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-950 text-sm"
            />
          </div>
          <select
            value={selectedCategory}
            onChange={e => setSelectedCategory(e.target.value)}
            className="px-3 py-2 rounded-xl border text-xs font-semibold"
          >
            <option value="all">All</option>
            <option value="document">Documents</option>
            <option value="image">Images</option>
            <option value="spreadsheet">Sheets</option>
            <option value="google_drive">Drive only</option>
          </select>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-zinc-500">
            Indexed bodies: <strong>{indexedCount}</strong>
            {driveFilesCount ? ` \u00b7 ${driveFilesCount} Drive files in list` : ''}
          </span>
          <button
            type="button"
            disabled={indexing}
            onClick={handleIndexContent}
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-indigo-600 text-white font-bold disabled:opacity-50"
          >
            {indexing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Database className="w-3.5 h-3.5" />}
            {indexing ? 'Indexing\u2026' : resumeFrom > 0 ? `Resume indexing (${resumeFrom}+)` : 'Index extractable content'}
          </button>
          {indexing && (
            <button
              type="button"
              onClick={() => {
                cancelIndexRef.current = true;
              }}
              className="px-2 py-1.5 rounded-lg border text-xs font-semibold"
            >
              Cancel
            </button>
          )}
        </div>
        {indexProgress && (
          <p className="text-[11px] text-zinc-500 font-mono break-all">{indexProgress}</p>
        )}
      </div>

      <div className="space-y-2">
        {searching && (
          <div className="flex items-center gap-2 text-xs text-zinc-500 py-4 justify-center">
            <Loader2 className="w-4 h-4 animate-spin" /> Searching\u2026
          </div>
        )}
        {!searching && results.length === 0 && query.trim() && (
          indexedCount === 0 ? (
            <div className="text-center py-8 space-y-3">
              <p className="text-sm text-zinc-500">
                Content index is empty \u2014 index extractable files for body search.
              </p>
              <button
                type="button"
                disabled={indexing}
                onClick={handleIndexContent}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-xs font-bold"
              >
                {indexing ? 'Indexing\u2026' : resumeFrom > 0 ? `Resume indexing (${resumeFrom}+)` : 'Index extractable content'}
              </button>
            </div>
          ) : (
            <p className="text-sm text-zinc-500 text-center py-8">No matches. Broaden the query.</p>
          )
        )}
        {!searching && results.map(r => (
          <div
            key={r.file.id}
            className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3 space-y-2"
          >
            <div className="flex items-start justify-between gap-2">
              <button type="button" className="text-left min-w-0 flex-1" onClick={() => onSelectFile(r.file)}>
                <div className="text-sm font-semibold truncate">{r.file.name}</div>
                <div className="text-[11px] text-zinc-500 mt-0.5">{r.relevanceReason} \u00b7 score {r.score}</div>
              </button>
              <div className="flex items-center gap-1 shrink-0">
                <button type="button" title="Star" onClick={() => onToggleStar(r.file.id)}>
                  <Star className={`w-4 h-4 ${r.file.starred ? 'text-amber-500 fill-amber-500' : 'text-zinc-400'}`} />
                </button>
                <button type="button" title="Pin offline" onClick={() => onToggleOffline(r.file.id)}>
                  <Pin className={`w-4 h-4 ${r.file.isOffline ? 'text-emerald-500' : 'text-zinc-400'}`} />
                </button>
                <button type="button" title="Copy link" onClick={() => copyLink(r.file)}>
                  <Link2 className={`w-4 h-4 ${copiedId === r.file.id ? 'text-blue-500' : 'text-zinc-400'}`} />
                </button>
                <button type="button" title="Move" onClick={() => onMoveFile(r.file)}>
                  <FolderInput className="w-4 h-4 text-indigo-500" />
                </button>
              </div>
            </div>
            {r.matchedSnippet && (
              <p className="text-[11px] text-zinc-600 dark:text-zinc-400 leading-relaxed">
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
      </div>
    </div>
  );
};
