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

  // PLACEHOLDER_CONTINUE - this is incomplete and will fail typecheck until full body is restored
  return (
    <div className="flex flex-col h-full gap-3">
      <div className="text-sm text-muted-foreground p-3">Semantic search loading…</div>
    </div>
  );
};
