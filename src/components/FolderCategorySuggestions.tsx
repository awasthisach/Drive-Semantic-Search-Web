import React, { useCallback, useEffect, useState } from 'react';
import { FolderInput, Loader2, RefreshCw, Sparkles } from 'lucide-react';
import type { DriveFile, FolderItem } from '../types';
import { createEmbeddingProvider } from '../lib/embeddings/client';
import { EMBED_CONFIG, isEmbedConfigured } from '../lib/embeddings/config';
import { isEmbeddingConsentGranted } from '../lib/embeddings/consent';
import { getFirebaseIdToken } from '../lib/firebaseAuth';
import { getVectorsForFile, listVectors, type VectorRecord } from '../lib/vectorIndex';
import { getIndexedDocument, listIndexedDocuments, buildEmbeddingChunks } from '../lib/contentIndex';
import { isLegacyTitleEmbeddingChunk } from '../lib/contentIndex';
import {
  averageEmbedding,
  buildFolderEmbeddingTexts,
  rankFolderSuggestions,
  type RankedFolderSuggestion,
} from '../lib/categorySuggestions';

interface FolderCategorySuggestionsProps {
  files: DriveFile[];
  folders: FolderItem[];
  corpusKey: string;
  refreshKey?: number;
  onReviewMove: (file: DriveFile, folderId: string) => void;
  onRequestIndex?: () => void;
}

interface CachedFolderEmbedding {
  embedding: number[];
}

// Session-memory cache only. Folder labels are re-embedded after a reload, but
// no document text is re-sent to the Worker by this suggestion panel.
const folderEmbeddingCache = new Map<string, CachedFolderEmbedding>();
const FOLDER_EMBED_BATCH_SIZE = 32;

function folderCacheKey(corpusKey: string, folder: FolderItem, labelText: string): string {
  return [corpusKey, folder.id, labelText, EMBED_CONFIG.model, EMBED_CONFIG.version].join('\u0000');
}

function compatibleVector(record: VectorRecord, provider: ReturnType<typeof createEmbeddingProvider>): boolean {
  return record.embeddingModel === provider.embeddingModel &&
    record.embeddingVersion === provider.embeddingVersion &&
    record.dimension === provider.dimension &&
    record.embedding.length === provider.dimension &&
    record.embedding.every(Number.isFinite);
}

export const FolderCategorySuggestions: React.FC<FolderCategorySuggestionsProps> = ({
  files,
  folders,
  corpusKey,
  refreshKey = 0,
  onReviewMove,
  onRequestIndex,
}) => {
  const [indexedFiles, setIndexedFiles] = useState<DriveFile[]>([]);
  const [selectedFileId, setSelectedFileId] = useState('');
  const [suggestions, setSuggestions] = useState<RankedFolderSuggestion[]>([]);
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(false);

  const selectedFile = indexedFiles.find(file => file.id === selectedFileId) || null;

  const refreshIndexedFiles = useCallback(async () => {
    try {
      const [docs, vectors] = await Promise.all([listIndexedDocuments(corpusKey), listVectors(corpusKey)]);
      const liveById = new Map(files.filter(file => file.isGoogleDriveItem).map(file => [file.id, file]));
      const legacyIds = new Set(vectors
        .filter(vector => liveById.has(vector.fileId) && isLegacyTitleEmbeddingChunk(vector.text))
        .map(vector => vector.fileId));
      const compatibleVectorIds = new Set(vectors
        .filter(vector => !legacyIds.has(vector.fileId) && vector.embeddingModel === EMBED_CONFIG.model && vector.embeddingVersion === EMBED_CONFIG.version && vector.dimension === EMBED_CONFIG.dimension)
        .map(vector => vector.fileId));
      const available = docs
        .map(doc => liveById.get(doc.id))
        .filter((file): file is DriveFile => Boolean(file))
        .sort((a, b) => a.name.localeCompare(b.name));
      setIndexedFiles(available);
      setSelectedFileId(current => available.some(file => file.id === current) ? current : (available[0]?.id || ''));
      setSuggestions([]);
      setStatus(available.length
        ? available.length + ' indexed Drive file(s) available. ' + (compatibleVectorIds.size ? compatibleVectorIds.size + ' already have semantic vectors.' : 'Semantic profiles will be generated when you request a suggestion.') + (legacyIds.size ? ' ' + legacyIds.size + ' legacy profile(s) excluded from semantic scoring.' : '')
        : 'No indexed Drive files yet. Index content first.');
    } catch (error) {
      setStatus(`Could not load indexed vectors: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [corpusKey, files]);

  useEffect(() => {
    void refreshIndexedFiles();
  }, [refreshIndexedFiles, refreshKey]);

  const suggestFolders = async () => {
    if (!selectedFile) {
      setStatus('Choose an indexed Drive file first.');
      return;
    }
    if (!folders.length) {
      setStatus('No existing Drive folders are loaded. Sync Drive folders first.');
      return;
    }
    if (!isEmbedConfigured()) {
      setStatus('The semantic embedding Worker is not configured.');
      return;
    }
    if (!isEmbeddingConsentGranted()) {
      setStatus('Enable embeddings in the header first. Only existing folder names/paths are sent for these suggestions; no file is moved automatically.');
      return;
    }

    setLoading(true);
    setSuggestions([]);
    try {
      const provider = createEmbeddingProvider(() => getFirebaseIdToken());
      const rows = (await getVectorsForFile(selectedFile.id, corpusKey)).filter(row => compatibleVector(row, provider));
      let profile = averageEmbedding(rows.map(row => row.embedding));
      if (!profile.length) {
        if (!isEmbeddingConsentGranted()) {
          setStatus('Enable embeddings first. The selected file text is sent only to the authenticated embedding Worker after consent.');
          return;
        }
        const indexed = await getIndexedDocument(selectedFile.id);
        if (!indexed?.text) {
          setStatus('This indexed file has no searchable text. Re-index it before requesting a folder suggestion.');
          return;
        }
        setStatus('Building the semantic profile for “' + selectedFile.name + '”…');
        const chunks = buildEmbeddingChunks(indexed.name || selectedFile.name, indexed.text);
        const embedded = await provider.embedDocuments(chunks);
        profile = averageEmbedding(embedded);
        if (!profile.length) {
          setStatus('Could not build a semantic profile for this file. Retry after confirming embeddings are enabled.');
          return;
        }
      }

      const folderTexts = buildFolderEmbeddingTexts(folders);
      const labels = folders.map(folder => ({
        folder,
        text: folderTexts.get(folder.id) || `Existing Google Drive category folder names: ${folder.name}`,
      }));
      const embeddings = new Map<string, number[]>();
      const missing: typeof labels = [];
      for (const item of labels) {
        const key = folderCacheKey(corpusKey, item.folder, item.text);
        const cached = folderEmbeddingCache.get(key);
        if (cached) embeddings.set(item.folder.id, cached.embedding);
        else missing.push(item);
      }

      for (let start = 0; start < missing.length; start += FOLDER_EMBED_BATCH_SIZE) {
        const batch = missing.slice(start, start + FOLDER_EMBED_BATCH_SIZE);
        setStatus(`Embedding existing folder labels ${Math.min(start + batch.length, missing.length)}/${missing.length}…`);
        const vectors = await provider.embedDocuments(batch.map(item => item.text));
        if (vectors.length !== batch.length) throw new Error('Folder embedding batch length mismatch.');
        for (let index = 0; index < batch.length; index++) {
          const item = batch[index];
          const embedding = vectors[index];
          if (embedding.length !== provider.dimension || embedding.some(value => !Number.isFinite(value))) {
            throw new Error(`Invalid folder embedding for ${item.folder.name}.`);
          }
          const key = folderCacheKey(corpusKey, item.folder, item.text);
          folderEmbeddingCache.set(key, { embedding });
          embeddings.set(item.folder.id, embedding);
        }
      }

      const ranked = rankFolderSuggestions(profile, folders, embeddings, 5);
      setSuggestions(ranked);
      setStatus(ranked.length
        ? `Top ${ranked.length} suggestions for “${selectedFile.name}”. Scores are relative similarity, not confidence; choose manually.`
        : 'No usable existing folder labels were available for comparison.');
    } catch (error) {
      setStatus(`Folder suggestions failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="rounded-xl border border-violet-200 dark:border-violet-900/60 bg-violet-50/40 dark:bg-violet-950/10 p-3 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Sparkles className="w-4 h-4 text-violet-600 shrink-0" />
          <h3 className="text-xs font-bold">Suggest an existing Drive folder</h3>
        </div>
        <button
          type="button"
          onClick={() => void refreshIndexedFiles()}
          disabled={loading}
          className="inline-flex items-center gap-1 px-2 py-1 rounded border text-[10px] disabled:opacity-50"
          title="Refresh files with current semantic vectors"
        >
          <RefreshCw className="w-3 h-3" /> Refresh
        </button>
      </div>
      <p className="text-[11px] text-zinc-600 dark:text-zinc-400">
        Compares one indexed file profile with your current Drive folder names (including parent names). Suggestions never move files; Review move opens the normal dialog with the suggestion preselected.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Indexed Drive file for folder suggestion"
          className="min-w-[220px] flex-1 text-xs border rounded-lg px-2 py-2 bg-background"
          value={selectedFileId}
          onChange={event => { setSelectedFileId(event.target.value); setSuggestions([]); }}
          disabled={!indexedFiles.length || loading}
        >
          {!indexedFiles.length && <option value="">No indexed Drive files</option>}
          {indexedFiles.map(file => <option key={file.id} value={file.id}>{file.name}</option>)}
        </select>
        <button
          type="button"
          onClick={() => void suggestFolders()}
          disabled={loading || !folders.length}
          className="inline-flex items-center gap-1 px-3 py-2 rounded-lg bg-violet-600 hover:bg-violet-700 text-white text-[11px] font-bold disabled:opacity-50"
        >
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
          Suggest folders
        </button>
      </div>
      {status && <p className="text-[10px] text-zinc-500" role="status">{status}</p>}
      {!indexedFiles.length && onRequestIndex && !loading && (
        <button
          type="button"
          onClick={onRequestIndex}
          className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-violet-300 text-violet-700 dark:text-violet-300 text-[10px] font-semibold hover:bg-violet-50 dark:hover:bg-violet-950/40"
        >
          Index content to enable suggestions
        </button>
      )}
      {suggestions.length > 0 && selectedFile && (
        <div className="space-y-1.5">
          {suggestions.map(suggestion => (
            <div key={suggestion.folder.id} className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 rounded-lg border bg-white/70 dark:bg-zinc-900/60 px-2.5 py-2">
              <div className="min-w-0">
                <div className="text-xs font-semibold truncate" title={suggestion.label}>{suggestion.label}</div>
                <div className="text-[10px] text-zinc-500">Cosine similarity {suggestion.score.toFixed(2)} · suggestion only</div>
              </div>
              <button
                type="button"
                onClick={() => onReviewMove(selectedFile, suggestion.folder.id)}
                className="inline-flex items-center justify-center gap-1 shrink-0 px-2 py-1 rounded border border-violet-400 text-violet-700 dark:text-violet-300 text-[10px] font-semibold hover:bg-violet-50 dark:hover:bg-violet-950/40"
              >
                <FolderInput className="w-3 h-3" /> Review move
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
};
