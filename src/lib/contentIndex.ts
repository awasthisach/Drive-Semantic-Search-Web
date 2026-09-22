/**
 * Durable content index + inverted postings (browser FTS-style).
 */
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

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .filter(t => t.length >= 2);
}

export function isDocumentStale(
  existing: IndexedDocument | null | undefined,
  driveModifiedTime?: string
): boolean {
  if (!existing) return true;
  if (!driveModifiedTime) return false;
  if (!existing.driveModifiedTime) return true;
  return existing.driveModifiedTime !== driveModifiedTime;
}

export async function putIndexedDocument(doc: {
  id: string;
  name: string;
  mimeType: string;
  text: string;
  source: IndexedDocument['source'];
  driveModifiedTime?: string;
  textTruncated?: boolean;
  corpusKey?: string;
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
    corpusKey: doc.corpusKey,
  };
  const db = await openDb();
  await removeIndexedDocument(doc.id);
  return new Promise((resolve, reject) => {
    const tx = db.transaction([DOC_STORE, CHUNK_STORE, POSTING_STORE], 'readwrite');
    tx.objectStore(DOC_STORE).put(indexed);
    const termBest = new Map<string, { tf: number; chunkIdx: number }>();
    chunks.forEach((ch, idx) => {
      const chunkId = doc.id + '#' + idx;
      tx.objectStore(CHUNK_STORE).put({ id: chunkId, fileId: doc.id, idx, text: ch });
      const terms = tokenize(ch);
      const tf = new Map<string, number>();
      for (const term of terms) tf.set(term, (tf.get(term) || 0) + 1);
      for (const [term, count] of tf) {
        const prev = termBest.get(term);
        if (!prev || count > prev.tf) termBest.set(term, { tf: count, chunkIdx: idx });
      }
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
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function removeIndexedDocument(id: string): Promise<void> {
  try {
    const db = await openDb();
    const chunks = await getChunksForFile(id);
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([DOC_STORE, CHUNK_STORE, POSTING_STORE], 'readwrite');
      tx.objectStore(DOC_STORE).delete(id);
      for (const c of chunks) tx.objectStore(CHUNK_STORE).delete(c.id);
      const postingsReq = tx.objectStore(POSTING_STORE).index('fileId').getAllKeys(id);
      postingsReq.onsuccess = () => {
        for (const key of postingsReq.result || []) tx.objectStore(POSTING_STORE).delete(key);
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.warn('[contentIndex] remove failed', id, e);
  }
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
  for (const [fileId, acc] of ranked) {
    let snippet = '';
    try {
      const chunks = await getChunksForFile(fileId);
      const ch = chunks.find(c => c.idx === acc.bestChunkIdx) || chunks[0];
      snippet = (ch?.text || '').slice(0, 160).trim();
    } catch { /* ignore */ }
    out.set(fileId, { score: acc.score, snippet });
  }
  return out;
}
