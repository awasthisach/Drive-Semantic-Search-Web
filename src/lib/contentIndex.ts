/**
 * Durable content index for extracted document text (IndexedDB).
 * Enables hybrid search over file body, not only Drive metadata.
 */

const DB_NAME = 'drive-semantic-content';
const DB_VERSION = 1;
const DOC_STORE = 'documents';
const CHUNK_STORE = 'chunks';

export const CHUNK_SIZE = 800;
export const CHUNK_OVERLAP = 120;
/** Max characters stored per document body (export/binary text). */
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
  /** Drive modifiedTime at index time — used for stale detection */
  driveModifiedTime?: string;
  /** True when body was truncated to MAX_INDEX_CHARS */
  textTruncated?: boolean;
}

export interface IndexedChunk {
  id: string;
  fileId: string;
  idx: number;
  text: string;
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
      if (!db.objectStoreNames.contains(DOC_STORE)) {
        db.createObjectStore(DOC_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(CHUNK_STORE)) {
        const cs = db.createObjectStore(CHUNK_STORE, { keyPath: 'id' });
        cs.createIndex('fileId', 'fileId', { unique: false });
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
    i = end - CHUNK_OVERLAP;
    if (i < 0) i = 0;
  }
  return chunks;
}

/** True when Drive file is newer than the last indexed snapshot (or never indexed). */
export function isDocumentStale(
  existing: IndexedDocument | null | undefined,
  driveModifiedTime?: string
): boolean {
  if (!existing) return true;
  if (!driveModifiedTime) return false;
  if (!existing.driveModifiedTime) return true;
  return driveModifiedTime > existing.driveModifiedTime;
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
    text,
    charCount: text.length,
    chunkCount: chunks.length,
    indexedAt: new Date().toISOString(),
    source: doc.source,
    driveModifiedTime: doc.driveModifiedTime,
    textTruncated: truncated,
  };

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([DOC_STORE, CHUNK_STORE], 'readwrite');
    tx.objectStore(DOC_STORE).put(record);
    const cs = tx.objectStore(CHUNK_STORE);
    const idx = cs.index('fileId');
    const req = idx.getAllKeys(doc.id);
    req.onsuccess = () => {
      for (const key of req.result || []) cs.delete(key);
      chunks.forEach((t, i) => {
        cs.put({ id: doc.id + '#' + i, fileId: doc.id, idx: i, text: t } as IndexedChunk);
      });
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  return record;
}

export async function removeIndexedDocument(id: string): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([DOC_STORE, CHUNK_STORE], 'readwrite');
      tx.objectStore(DOC_STORE).delete(id);
      const cs = tx.objectStore(CHUNK_STORE);
      const idx = cs.index('fileId');
      const req = idx.getAllKeys(id);
      req.onsuccess = () => {
        for (const key of req.result || []) cs.delete(key);
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.warn('[contentIndex] remove failed', id, e);
  }
}

/** Drop index rows for files no longer present in the current Drive list. */
export async function pruneMissingFromIndex(liveFileIds: Set<string>): Promise<number> {
  const docs = await listIndexedDocuments();
  let removed = 0;
  for (const d of docs) {
    if (!liveFileIds.has(d.id)) {
      await removeIndexedDocument(d.id);
      removed++;
    }
  }
  return removed;
}

export async function getIndexedDocument(id: string): Promise<IndexedDocument | null> {
  try {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DOC_STORE, 'readonly');
      const req = tx.objectStore(DOC_STORE).get(id);
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
      const tx = db.transaction(DOC_STORE, 'readonly');
      const req = tx.objectStore(DOC_STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

export async function getChunksForFile(fileId: string): Promise<IndexedChunk[]> {
  try {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(CHUNK_STORE, 'readonly');
      const req = tx.objectStore(CHUNK_STORE).index('fileId').getAll(fileId);
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
      const tx = db.transaction(CHUNK_STORE, 'readonly');
      const req = tx.objectStore(CHUNK_STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

/** BM25-style heuristic scoring over chunks for a query. Returns best score per fileId. */
export async function searchContentIndex(
  query: string
): Promise<Map<string, { score: number; snippet: string }>> {
  const q = query.trim().toLowerCase();
  const terms = q.split(/\s+/).filter(t => t.length > 1);
  const out = new Map<string, { score: number; snippet: string }>();
  if (!terms.length) return out;

  const chunks = await getAllChunks();
  const N = Math.max(chunks.length, 1);
  const df = new Map<string, number>();
  for (const term of terms) {
    let c = 0;
    for (const ch of chunks) {
      if (ch.text.toLowerCase().includes(term)) c++;
    }
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
    if (!prev || score > prev.score) {
      const snippet = ch.text.slice(0, 160).trim();
      out.set(ch.fileId, { score, snippet });
    }
  }
  return out;
}
