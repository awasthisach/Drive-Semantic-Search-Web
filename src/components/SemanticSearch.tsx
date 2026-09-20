import React, { useState, useEffect, useCallback } from 'react';
import {
  Search, Sparkles, Loader2, Database, FolderInput,
} from 'lucide-react';
import { DriveFile, FolderItem, SemanticSearchResult } from '../types';
import { runHybridSearch } from '../lib/searchEngine';
import { formatBytes } from '../lib/driveApi';
import { canExtractText, extractDriveFileText } from '../lib/contentExtract';
import {
  putIndexedDocument,
  listIndexedDocuments,
  getIndexedDocument,
  isDocumentStale,
  MAX_INDEX_CHARS,
} from '../lib/contentIndex';

interface SemanticSearchProps {
  files: DriveFile[];
  folders?: FolderItem[];
  onSelectFile: (file: DriveFile) => void;
  onMoveFile?: (file: DriveFile) => void;
  accessToken?: string | null;
  onRequestToken?: () => Promise<string | null>;
}

const SAMPLE_PROMPTS = [
  'financial audits and fiscal reports',
  'hemp cultivation notes',
  'confidential client contracts',
  'sales projections and regional quota',
];

export const SemanticSearch: React.FC<SemanticSearchProps> = ({
  files,
  onSelectFile,
  onMoveFile,
  accessToken,
  onRequestToken,
}) => {
  const [query, setQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [results, setResults] = useState<SemanticSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [indexedCount, setIndexedCount] = useState(0);
  const [indexing, setIndexing] = useState(false);
  const [indexProgress, setIndexProgress] = useState('');

  const refreshIndexedCount = useCallback(async () => {
    const docs = await listIndexedDocuments();
    setIndexedCount(docs.length);
  }, []);

  useEffect(() => {
    refreshIndexedCount();
  }, [refreshIndexedCount]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setSearching(true);
      try {
        const r = await runHybridSearch(query, files, selectedCategory);
        if (!cancelled) setResults(r);
      } finally {
        if (!cancelled) setSearching(false);
      }
    })();
    return () => { cancelled = true; };
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

    setIndexing(true);
    let ok = 0;
    let fail = 0;
    let skippedFresh = 0;
    let truncated = 0;
    for (let i = 0; i < extractable.length; i++) {
      const f = extractable[i];
      setIndexProgress(`Checking ${i + 1}/${extractable.length}: ${f.name}`);
      try {
        const existing = await getIndexedDocument(f.id);
        if (!isDocumentStale(existing, f.modifiedTime)) {
          skippedFresh++;
          continue;
        }
        setIndexProgress(`Indexing ${i + 1}/${extractable.length}: ${f.name}`);
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
          });
          ok++;
          if (wasTrunc) truncated++;
        } else {
          fail++;
        }
      } catch {
        fail++;
      }
      await new Promise(r => setTimeout(r, 100));
    }
    setIndexProgress(
      `Done: ${ok} indexed, ${skippedFresh} already fresh, ${fail} skipped/failed` +
        (truncated ? `, ${truncated} truncated to ${MAX_INDEX_CHARS.toLocaleString()} chars` : '')
    );
    setIndexing(false);
    await refreshIndexedCount();
    const r = await runHybridSearch(query, files, selectedCategory);
    setResults(r);
  };

  const categories = [
    { label: 'All Files', value: 'all' },
    { label: `Google Drive (${driveFilesCount})`, value: 'google_drive' },
    { label: 'Documents', value: 'document' },
    { label: 'Images', value: 'image' },
    { label: 'Spreadsheets', value: 'spreadsheet' },
  ];

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-blue-200/80 dark:border-blue-900/40 bg-blue-50/80 dark:bg-blue-950/20 px-3 py-2 text-[11px] text-blue-900 dark:text-blue-200 font-medium">
        Hybrid search: metadata keywords + extracted document body (BM25-style). Not neural embeddings. Bodies capped at first 500k characters; re-index after Drive edits.
        Indexed bodies: <strong>{indexedCount}</strong>
      </div>

      <div className="rounded-2xl p-5 bg-gradient-to-br from-blue-950/80 via-zinc-900 to-zinc-950 text-white border border-blue-900/30">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Sparkles className="w-6 h-6 text-blue-400" />
            <div>
              <h2 className="text-lg font-bold">Hybrid Content Search</h2>
              <p className="text-xs text-zinc-400">Index Docs/Sheets/text first, then search inside file bodies</p>
            </div>
          </div>
          <button
            type="button"
            disabled={indexing}
            onClick={handleIndexContent}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-blue-600 text-white text-xs font-bold disabled:opacity-50"
          >
            {indexing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Database className="w-4 h-4" />}
            {indexing ? 'Indexing…' : 'Index extractable content'}
          </button>
        </div>
        {indexProgress && <p className="text-[11px] text-zinc-400 mt-2">{indexProgress}</p>}
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-400" />
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search inside names, tags, and indexed content…"
          className="w-full pl-10 pr-3 py-3 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm"
        />
      </div>

      <div className="flex flex-wrap gap-2">
        {SAMPLE_PROMPTS.map(p => (
          <button key={p} type="button" onClick={() => setQuery(p)} className="text-[11px] px-2 py-1 rounded-lg border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800">
            {p}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap gap-2">
        {categories.map(c => (
          <button
            key={c.value}
            type="button"
            onClick={() => setSelectedCategory(c.value)}
            className={`text-xs px-3 py-1.5 rounded-lg font-semibold ${selectedCategory === c.value ? 'bg-blue-600 text-white' : 'bg-zinc-100 dark:bg-zinc-800'}`}
          >
            {c.label}
          </button>
        ))}
      </div>

      {searching && <p className="text-xs text-zinc-500">Searching…</p>}

      <div className="space-y-2">
        {results.length === 0 && query.trim() && !searching && (
          <p className="text-sm text-zinc-500 text-center py-8">No matches. Index content or broaden the query.</p>
        )}
        {results.map(r => (
          <button
            key={r.file.id}
            type="button"
            onClick={() => onSelectFile(r.file)}
            className="w-full text-left rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3 hover:border-blue-400 transition"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="text-sm font-semibold truncate">{r.file.name}</div>
                <div className="text-[11px] text-zinc-500 mt-0.5">{formatBytes(r.file.size)} · {r.relevanceReason}</div>
                <p className="text-xs text-zinc-600 dark:text-zinc-400 mt-1 line-clamp-2">{r.matchedSnippet}</p>
              </div>
              <div className="flex flex-col items-end gap-1 shrink-0">
                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-600">
                  {r.score > 0 ? `Match ${r.score}` : '—'}
                </span>
                {onMoveFile && (
                  <span
                    role="button"
                    tabIndex={0}
                    className="inline-flex items-center gap-0.5 text-[10px] font-bold text-indigo-600 hover:underline"
                    onClick={e => {
                      e.stopPropagation();
                      onMoveFile(r.file);
                    }}
                    onKeyDown={e => {
                      if (e.key === 'Enter') {
                        e.stopPropagation();
                        onMoveFile(r.file);
                      }
                    }}
                  >
                    <FolderInput className="w-3.5 h-3.5" /> Move
                  </span>
                )}
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
};
