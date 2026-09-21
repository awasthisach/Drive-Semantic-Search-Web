/**
 * Durable content index + inverted postings (browser FTS-style).
 */
const DB_NAME = 'drive-semantic-content';
const DB_VERSION = 2;
const DOC_STORE = 'documents';
const CHUNK_STORE = 'chunks';
const POSTING_STORE = 'postings';

export const CHUNK_SIZE = 800;
export const CHUNK_OVERLAP = 120;
export const MAX_INDEX_CHARS = 500_000;
const MAX_TERMS_PER_DOC = 8_000;

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
    i = Math.max(0, end - CHUNK_OVERLAP);
  }
  return chunks;
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9\u0900-\u097f]+/i)
    .filter(t => t.length >= 2);
}

export function isDocumentStale(
  existing: IndexedDocument | null | undefined,
  driveModifiedTime?: string
): boolean {
  if (!existing) return true;
  if (!driveModifiedTime) return false;
  if (!existing.driveModifiedTime) return true;
  return driveModifiedTime > existing.driveModifiedTime;
}

function buildPostings(fileId: string, chunks: string[]): Posting[] {
  const map = new Map<string, { tf: number; bestChunkIdx: number; bestInChunk: number }>();
  for (let ci = 0; ci < chunks.length; ci++) {
    const inChunk = new Map<string, number>();
    for (const t of tokenize(chunks[ci])) inChunk.set(t, (inChunk.get(t) || 0) + 1);
    for (const [t, ctf] of inChunk) {
      const prev = map.get(t);
      if (!prev) map.set(t, { tf: ctf, bestChunkIdx: ci, bestInChunk: ctf });
      else {
        prev.tf += ctf;
        if (ctf > prev.bestInChunk) {
          prev.bestInChunk = ctf;
          prev.bestChunkIdx = ci;
        }
      }
    }
  }
  const postings: Posting[] = [];
  for (const [term, v] of map) {
    if (postings.length >= MAX_TERMS_PER_DOC) break;
    postings.push({ id: term + '#' + fileId, term, fileId, tf: v.tf, bestChunkIdx: v.bestChunkIdx });
  }
  return postings;
}

export async function putIndexedDocument(
  doc: Omit<IndexedDocument, 'charCount' | 'chunkCount' | 'indexedAt'> & { text: string }
): Promise<IndexedDocument> {
  const db = await openDb();
  const truncated = doc.text.length > MAX_INDEX_CHARS || Boolean(doc.textTruncated);
  const text = doc.text.slice(0, MAX_INDEX_CHARS);
  const chunks = chunkText(text);
  const record: IndexedDocument = {
    id: doc.id,
    name: doc.name,
    mimeType: doc.mimeType,
    text: text.slice(0, 2000),
    charCount: text.length,
    chunkCount: chunks.length,
    indexedAt: new Date().toISOString(),
    source: doc.source,
    driveModifiedTime: doc.driveModifiedTime,
    textTruncated: truncated,
    corpusKey: doc.corpusKey,
  };
  const postings = buildPostings(doc.id, chunks);

  await new Promise<void>((resolve, reject) => {
    const stores = [DOC_STORE, CHUNK_STORE];
    if (db.objectStoreNames.contains(POSTING_STORE)) stores.push(POSTING_STORE);
    const tx = db.transaction(stores, 'readwrite');
    tx.objectStore(DOC_STORE).put(record);
    const cs = tx.objectStore(CHUNK_STORE);
    const creq = cs.index('fileId').getAllKeys(doc.id);
    creq.onsuccess = () => {
      for (const key of creq.result || []) cs.delete(key);
      chunks.forEach((t, i) => cs.put({ id: doc.id + '#' + i, fileId: doc.id, idx: i, text: t } as IndexedChunk));
    };
    if (db.objectStoreNames.contains(POSTING_STORE)) {
      const ps = tx.objectStore(POSTING_STORE);
      const preq = ps.index('fileId').getAllKeys(doc.id);
      preq.onsuccess = () => {
        for (const key of preq.result || []) ps.delete(key);
        for (const p of postings) ps.put(p);
      };
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  return record;
}

export async function removeIndexedDocument(id: string): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const stores = [DOC_STORE, CHUNK_STORE];
      if (db.objectStoreNames.contains(POSTING_STORE)) stores.push(POSTING_STORE);
      const tx = db.transaction(stores, 'readwrite');
      tx.objectStore(DOC_STORE).delete(id);
      const cs = tx.objectStore(CHUNK_STORE);
      const req = cs.index('fileId').getAllKeys(id);
      req.onsuccess = () => { for (const key of req.result || []) cs.delete(key); };
      if (db.objectStoreNames.contains(POSTING_STORE)) {
        const ps = tx.objectStore(POSTING_STORE);
        const preq = ps.index('fileId').getAllKeys(id);
        preq.onsuccess = () => { for (const key of preq.result || []) ps.delete(key); };
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.warn('[contentIndex] remove failed', id, e);
  }
}

export type PruneOptions = {
  liveFileIds: Set<string>;
  /** Only prune docs that belong to this corpus (or legacy docs with no corpusKey when matching user). */
  corpusKey?: string;
  /**
   * When false (truncated list / filtered type sync), do nothing.
   * Incomplete enumerations must never delete index rows.
   */
  complete: boolean;
};

/**
 * Remove content-index docs whose file id is not in the live set.
 * SAFETY: only runs when complete === true (full non-truncated enumeration).
 * When corpusKey is set, only docs for that corpus are considered.
 */
export async function pruneMissingFromIndex(opts: PruneOptions | Set<string>): Promise<number> {
  // Back-compat: bare Set was unsafe; treat as incomplete (no-op) unless complete is explicit.
  if (opts instanceof Set) {
    console.warn('[contentIndex] pruneMissingFromIndex called without { complete } — refusing to prune');
    return 0;
  }
  if (!opts.complete) return 0;

  const docs = await listIndexedDocuments();
  let removed = 0;
  for (const d of docs) {
    if (opts.corpusKey) {
      // Skip docs from other corpora; legacy (no corpusKey) only match when pruning user corpus
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

/** Targeted removal for Changes API deleted/trashed file ids (safe even when baseline incomplete). */
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

export async function listIndexedDocuments(): Promise<IndexedDocument[]> {
  try {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const req = db.transaction(DOC_STORE, 'readonly').objectStore(DOC_STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

/** Cheap DOC_STORE count — for IDF N without loading every document preview. */
export async function countIndexedDocuments(): Promise<number> {
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

export async function getAllChunks(): Promise<IndexedChunk[]> {
  try {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const req = db.transaction(CHUNK_STORE, 'readonly').objectStore(CHUNK_STORE).getAll();
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
  query: string
): Promise<Map<string, { score: number; snippet: string }>> {
  const terms = tokenize(query.trim().toLowerCase());
  const out = new Map<string, { score: number; snippet: string }>();
  if (!terms.length) return out;

  const termPostings: Posting[][] = [];
  for (const t of terms) termPostings.push(await getPostingsForTerm(t));
  if (!termPostings.some(p => p.length > 0)) return searchContentIndexLegacy(terms);

  const df = new Map<string, number>();
  for (let i = 0; i < terms.length; i++) {
    df.set(terms[i], new Set(termPostings[i].map(p => p.fileId)).size);
  }
  const allFiles = new Set<string>();
  for (const list of termPostings) for (const p of list) allFiles.add(p.fileId);
  // IDF needs total corpus size — use count(), not getAll() of every doc preview
  const corpusN = Math.max(await countIndexedDocuments(), allFiles.size, 1);
  const N = Math.max(corpusN, 1);

  type Acc = { score: number; bestChunkIdx: number; bestTf: number };
  const scores = new Map<string, Acc>();
  for (let i = 0; i < terms.length; i++) {
    const term = terms[i];
    const docFreq = df.get(term) || 0;
    const idf = Math.log(1 + (N - docFreq + 0.5) / (docFreq + 0.5));
    for (const p of termPostings[i]) {
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

async function searchContentIndexLegacy(
  terms: string[]
): Promise<Map<string, { score: number; snippet: string }>> {
  const out = new Map<string, { score: number; snippet: string }>();
  let chunks = await getAllChunks();
  const MAX_SCAN = 5_000;
  if (chunks.length > MAX_SCAN) chunks = chunks.slice(0, MAX_SCAN);
  const N = Math.max(chunks.length, 1);
  const df = new Map<string, number>();
  for (const term of terms) {
    let c = 0;
    for (const ch of chunks) if (ch.text.toLowerCase().includes(term)) c++;
    df.set(term, c);
  }
  for (const ch of chunks) {
    const text = ch.text.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (!text.includes(term)) continue;
      const tf = (text.match(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
      const docFreq = df.get(term) || 0;
      const idf = Math.log(1 + (N - docFreq + 0.5) / (docFreq + 0.5));
      score += (tf * idf) / (tf + 1.2);
    }
    if (score <= 0) continue;
    const prev = out.get(ch.fileId);
    if (!prev || score > prev.score) out.set(ch.fileId, { score, snippet: ch.text.slice(0, 160).trim() });
  }
  return out;
}
