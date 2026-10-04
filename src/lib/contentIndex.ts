/**
 * Durable content index + inverted postings (browser FTS-style).
 */
import { removeVectorsForFile } from './vectorIndex';
import type { PdfOcrCoverage } from './ocrExtract';
const DB_NAME = 'drive-content-index';
const DB_VERSION = 3;
const DOC_STORE = 'documents';
const CHUNK_STORE = 'chunks';
const POSTING_STORE = 'postings';

export const CHUNK_SIZE = 800;
export const CHUNK_OVERLAP = 120;
export const MAX_INDEX_CHARS = 500_000;

export interface IndexedDocument {
  id: string;
  name: string;
  mimeType: string;
  text: string;
  charCount: number;
  chunkCount: number;
  indexedAt: string;
  source: 'export' | 'binary-text' | 'offline-blob';
  driveModifiedTime?: string;
  textTruncated?: boolean;
  extractionPolicyVersion?: string;
  pdfCoverage?: PdfOcrCoverage;
  /** My Drive / Shared Drive scope — pruning is scoped to this key */
  corpusKey?: string;
}

/** Stable key matching driveMetaStore snapshot keys. */
export function makeCorpusKey(corpus: string, sharedDriveId?: string): string {
  if (corpus === 'drive' && sharedDriveId) return 'drive:' + sharedDriveId;
  if (corpus === 'allDrives') return 'allDrives';
  return 'user';
}

export interface IndexedChunk {
  id: string;
  fileId: string;
  idx: number;
  text: string;
}

export interface Posting {
  id: string;
  term: string;
  fileId: string;
  tf: number;
  bestChunkIdx: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB not available'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error || new Error('content index open failed'));
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DOC_STORE)) db.createObjectStore(DOC_STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(CHUNK_STORE)) {
        const cs = db.createObjectStore(CHUNK_STORE, { keyPath: 'id' });
        cs.createIndex('fileId', 'fileId', { unique: false });
      }
      if (!db.objectStoreNames.contains(POSTING_STORE)) {
        const ps = db.createObjectStore(POSTING_STORE, { keyPath: 'id' });
        ps.createIndex('term', 'term', { unique: false });
        ps.createIndex('fileId', 'fileId', { unique: false });
      }
    };
  });
}

export function chunkText(text: string): string[] {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (!cleaned) return [];
  const chunks: string[] = [];
  let i = 0;
  while (i < cleaned.length) {
    const end = Math.min(i + CHUNK_SIZE, cleaned.length);
    chunks.push(cleaned.slice(i, end));
    if (end >= cleaned.length) break;
    i = Math.max(end - CHUNK_OVERLAP, i + 1);
  }
  return chunks;
}

/** Neural document vectors contain body text only; names remain searchable through metadata/BM25. */
export function buildEmbeddingChunks(_name: string, text: string): string[] {
  return chunkText(text);
}

/** True for vectors created by the earlier `title: … | text: …` chunk format. */
export function isLegacyTitleEmbeddingChunk(text: string): boolean {
  return /^title: .* \| text: /.test(text);
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .filter(t => t.length >= 2);
}

export function isDocumentStale(
  existing: IndexedDocument | null | undefined,
  driveModifiedTime?: string,
  requiredExtractionPolicyVersion?: string
): boolean {
  if (!existing) return true;
  if (requiredExtractionPolicyVersion && existing.extractionPolicyVersion !== requiredExtractionPolicyVersion) return true;
  if (!driveModifiedTime) return false;
  if (!existing.driveModifiedTime) return true;
  return existing.driveModifiedTime !== driveModifiedTime;
}

function deleteRowsForFile(tx: IDBTransaction, id: string): void {
  for (const storeName of [CHUNK_STORE, POSTING_STORE]) {
    const cursorRequest = tx.objectStore(storeName).index('fileId').openCursor(IDBKeyRange.only(id));
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) return;
      cursor.delete();
      cursor.continue();
    };
  }
}

export async function putIndexedDocument(doc: {
  id: string;
  name: string;
  mimeType: string;
  text: string;
  source: IndexedDocument['source'];
  driveModifiedTime?: string;
  textTruncated?: boolean;
  extractionPolicyVersion?: string;
  pdfCoverage?: PdfOcrCoverage;
  corpusKey?: string;
  /** Keep vectors that were successfully staged before an expanded re-index. */
  preserveVectors?: boolean;
}): Promise<void> {
  const chunks = chunkText(doc.text);
  const indexed: IndexedDocument = {
    id: doc.id,
    name: doc.name,
    mimeType: doc.mimeType,
    text: doc.text,
    charCount: doc.text.length,
    chunkCount: chunks.length,
    indexedAt: new Date().toISOString(),
    source: doc.source,
    driveModifiedTime: doc.driveModifiedTime,
    textTruncated: doc.textTruncated,
    extractionPolicyVersion: doc.extractionPolicyVersion,
    pdfCoverage: doc.pdfCoverage,
    corpusKey: doc.corpusKey,
  };
  const db = await openDb();
  // Vector storage is a separate database. Remove the old derived vectors first;
  // if that fails, keep the old text index rather than pairing new text with stale vectors.
  if (!doc.preserveVectors) await removeVectorsForFile(doc.id, doc.corpusKey);
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([DOC_STORE, CHUNK_STORE, POSTING_STORE], 'readwrite');
    const termBest = new Map<string, { tf: number; chunkIdx: number }>();
    chunks.forEach((ch, idx) => {
      const terms = tokenize(ch);
      const tf = new Map<string, number>();
      for (const term of terms) tf.set(term, (tf.get(term) || 0) + 1);
      for (const [term, count] of tf) {
        const prev = termBest.get(term);
        if (!prev || count > prev.tf) termBest.set(term, { tf: count, chunkIdx: idx });
      }
    });
    const chunkKeys: IDBValidKey[] = [];
    const postingKeys: IDBValidKey[] = [];
    let cursorsRemaining = 2;
    const writeReplacement = () => {
      cursorsRemaining--;
      if (cursorsRemaining !== 0) return;
      for (const key of chunkKeys) tx.objectStore(CHUNK_STORE).delete(key);
      for (const key of postingKeys) tx.objectStore(POSTING_STORE).delete(key);
      tx.objectStore(DOC_STORE).put(indexed);
      chunks.forEach((ch, idx) => {
        tx.objectStore(CHUNK_STORE).put({ id: doc.id + '#' + idx, fileId: doc.id, idx, text: ch });
      });
      for (const [term, info] of termBest) {
        tx.objectStore(POSTING_STORE).put({
          id: term + '|' + doc.id,
          term,
          fileId: doc.id,
          tf: info.tf,
          bestChunkIdx: info.chunkIdx,
        });
      }
    };
    const chunkCursor = tx.objectStore(CHUNK_STORE).index('fileId').openCursor(IDBKeyRange.only(doc.id));
    chunkCursor.onsuccess = () => {
      const cursor = chunkCursor.result;
      if (!cursor) { writeReplacement(); return; }
      chunkKeys.push(cursor.primaryKey);
      cursor.continue();
    };
    const postingCursor = tx.objectStore(POSTING_STORE).index('fileId').openCursor(IDBKeyRange.only(doc.id));
    postingCursor.onsuccess = () => {
      const cursor = postingCursor.result;
      if (!cursor) { writeReplacement(); return; }
      postingKeys.push(cursor.primaryKey);
      cursor.continue();
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('content index replacement failed'));
    tx.onabort = () => reject(tx.error || new Error('content index replacement aborted'));
  });
}

export async function removeIndexedDocument(id: string): Promise<void> {
  // Delete derived vectors first so an IndexedDB text-store failure cannot leave
  // old semantic matches active for a document the caller believes was removed.
  await removeVectorsForFile(id);
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([DOC_STORE, CHUNK_STORE, POSTING_STORE], 'readwrite');
    tx.objectStore(DOC_STORE).delete(id);
    deleteRowsForFile(tx, id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('content index removal failed'));
    tx.onabort = () => reject(tx.error || new Error('content index removal aborted'));
  });
}

export type PruneOptions = {
  liveFileIds: Set<string>;
  corpusKey?: string;
  complete: boolean;
};

export async function pruneMissingFromIndex(opts: PruneOptions | Set<string>): Promise<number> {
  if (opts instanceof Set) {
    console.warn('[contentIndex] pruneMissingFromIndex called without { complete } — refusing to prune');
    return 0;
  }
  if (!opts.complete) return 0;
  const docs = await listIndexedDocuments();
  let removed = 0;
  for (const d of docs) {
    if (opts.corpusKey) {
      if (d.corpusKey && d.corpusKey !== opts.corpusKey) continue;
      if (!d.corpusKey && opts.corpusKey !== 'user') continue;
    }
    if (!opts.liveFileIds.has(d.id)) {
      await removeIndexedDocument(d.id);
      removed++;
    }
  }
  return removed;
}

export async function removeIndexedDocumentsByIds(ids: string[]): Promise<number> {
  let removed = 0;
  for (const id of ids) {
    await removeIndexedDocument(id);
    removed++;
  }
  return removed;
}

export async function getIndexedDocument(id: string): Promise<IndexedDocument | null> {
  try {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const req = db.transaction(DOC_STORE, 'readonly').objectStore(DOC_STORE).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

function matchesCorpus(d: IndexedDocument, corpusKey?: string): boolean {
  if (!corpusKey) return true;
  if (d.corpusKey && d.corpusKey !== corpusKey) return false;
  if (!d.corpusKey && corpusKey !== 'user') return false;
  return true;
}

export async function listIndexedDocuments(corpusKey?: string): Promise<IndexedDocument[]> {
  try {
    const db = await openDb();
    const all: IndexedDocument[] = await new Promise((resolve, reject) => {
      const req = db.transaction(DOC_STORE, 'readonly').objectStore(DOC_STORE).getAll();
      req.onsuccess = () => resolve((req.result || []) as IndexedDocument[]);
      req.onerror = () => reject(req.error);
    });
    if (!corpusKey) return all;
    return all.filter(d => matchesCorpus(d, corpusKey));
  } catch {
    return [];
  }
}

/** Strict read for backup export: unlike the UI helper, this propagates storage errors. */
export async function exportIndexedDocumentsForBackup(): Promise<IndexedDocument[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(DOC_STORE, 'readonly').objectStore(DOC_STORE).getAll();
    req.onsuccess = () => resolve((req.result || []) as IndexedDocument[]);
    req.onerror = () => reject(req.error || new Error('Could not read indexed documents for backup'));
  });
}

export async function countIndexedDocuments(corpusKey?: string): Promise<number> {
  if (corpusKey) {
    return (await listIndexedDocuments(corpusKey)).length;
  }
  try {
    const db = await openDb();
    return new Promise((resolve) => {
      const req = db.transaction(DOC_STORE, 'readonly').objectStore(DOC_STORE).count();
      req.onsuccess = () => resolve(req.result || 0);
      req.onerror = () => resolve(0);
    });
  } catch {
    return 0;
  }
}

export async function getChunksForFile(fileId: string): Promise<IndexedChunk[]> {
  try {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const req = db.transaction(CHUNK_STORE, 'readonly').objectStore(CHUNK_STORE).index('fileId').getAll(fileId);
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

async function getChunkSnippets(keys: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!keys.length) return out;
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(CHUNK_STORE, 'readonly');
      const store = tx.objectStore(CHUNK_STORE);
      for (const key of keys) {
        const req = store.get(key);
        req.onsuccess = () => {
          const row = req.result as IndexedChunk | undefined;
          if (row) out.set(key, (row.text || '').slice(0, 160).trim());
        };
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch {
    // Search results remain valid even when snippet hydration fails.
  }
  return out;
}

async function getPostingsForTerm(term: string): Promise<Posting[]> {
  try {
    const db = await openDb();
    if (!db.objectStoreNames.contains(POSTING_STORE)) return [];
    return new Promise((resolve, reject) => {
      const req = db.transaction(POSTING_STORE, 'readonly').objectStore(POSTING_STORE).index('term').getAll(term);
      req.onsuccess = () => resolve((req.result || []) as Posting[]);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

export async function searchContentIndex(
  query: string,
  corpusKey?: string
): Promise<Map<string, { score: number; snippet: string }>> {
  const terms = tokenize(query.trim().toLowerCase());
  const out = new Map<string, { score: number; snippet: string }>();
  if (!terms.length) return out;

  const termPostings: Posting[][] = await Promise.all(terms.map(t => getPostingsForTerm(t)));
  if (!termPostings.some(p => p.length > 0)) return out;

  let allowed: Set<string> | null = null;
  if (corpusKey) {
    allowed = new Set((await listIndexedDocuments(corpusKey)).map(d => d.id));
  }

  const filterPostings = (list: Posting[]) =>
    allowed ? list.filter(p => allowed!.has(p.fileId)) : list;

  const df = new Map<string, number>();
  for (let i = 0; i < terms.length; i++) {
    const scoped = filterPostings(termPostings[i]);
    df.set(terms[i], new Set(scoped.map(p => p.fileId)).size);
  }
  const allFiles = new Set<string>();
  for (const list of termPostings) for (const p of filterPostings(list)) allFiles.add(p.fileId);
  const corpusN = Math.max(await countIndexedDocuments(corpusKey), allFiles.size, 1);
  const N = Math.max(corpusN, 1);

  type Acc = { score: number; bestChunkIdx: number; bestTf: number };
  const scores = new Map<string, Acc>();
  for (let i = 0; i < terms.length; i++) {
    const term = terms[i];
    const docFreq = df.get(term) || 0;
    const idf = Math.log(1 + (N - docFreq + 0.5) / (docFreq + 0.5));
    for (const p of filterPostings(termPostings[i])) {
      const contrib = (p.tf * idf) / (p.tf + 1.2);
      const prev = scores.get(p.fileId);
      if (!prev) scores.set(p.fileId, { score: contrib, bestChunkIdx: p.bestChunkIdx, bestTf: p.tf });
      else {
        prev.score += contrib;
        if (p.tf > prev.bestTf) {
          prev.bestTf = p.tf;
          prev.bestChunkIdx = p.bestChunkIdx;
        }
      }
    }
  }

  const ranked = [...scores.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, 200);
  const snippetKeys = ranked.map(([fileId, acc]) => fileId + '#' + acc.bestChunkIdx);
  const snippets = await getChunkSnippets(snippetKeys);
  for (const [fileId, acc] of ranked) {
    const snippet = snippets.get(fileId + '#' + acc.bestChunkIdx) || '';
    out.set(fileId, { score: acc.score, snippet });
  }
  return out;
}
