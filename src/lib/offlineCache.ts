import { fetchWithBackoff } from './rateLimit';
/**
 * IndexedDB cache for offline-pinned file bytes.
 * Quota: max total bytes + max entries; true LRU — getOfflineBlob touches cachedAt.
 * Re-pin same id replaces size without double-counting entries.
 */

const DB_NAME = 'drive-semantic-offline';
const DB_VERSION = 3;
const STORE = 'blobs';
const META_STORE = 'meta';

export const MAX_CACHE_BYTES = 200 * 1024 * 1024;
export const MAX_CACHE_ENTRIES = 80;

export interface OfflineBlobMeta {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  cachedAt: string;
  sha256?: string;
}

export interface CacheStats {
  entryCount: number;
  totalBytes: number;
  maxBytes: number;
  maxEntries: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB not available'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error || new Error('IDB open failed'));
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: 'id' });
        try {
          os.createIndex('cachedAt', 'cachedAt', { unique: false });
        } catch {
          /* index may already exist */
        }
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: 'key' });
      }
    };
  });
}

async function getAllRows(db: IDBDatabase): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function enforceQuota(
  db: IDBDatabase,
  incomingSize: number,
  replaceId?: string
): Promise<string[]> {
  const rows = await getAllRows(db);
  const existing = replaceId ? rows.find((r: any) => r.id === replaceId) : undefined;
  let total = rows.reduce((s, r) => s + (r.size || 0), 0);
  let count = rows.length;
  if (existing) {
    total = total - (existing.size || 0) + incomingSize;
  } else {
    total = total + incomingSize;
    count = count + 1;
  }
  const evicted: string[] = [];
  if (total <= MAX_CACHE_BYTES && count <= MAX_CACHE_ENTRIES) return evicted;

  const sorted = [...rows]
    .filter((r: any) => r.id !== replaceId)
    .sort(
      (a, b) => new Date(a.cachedAt || 0).getTime() - new Date(b.cachedAt || 0).getTime()
    );

  for (const row of sorted) {
    if (total <= MAX_CACHE_BYTES && count <= MAX_CACHE_ENTRIES) break;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(row.id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    evicted.push(row.id);
    total -= row.size || 0;
    count -= 1;
  }
  return evicted;
}

export async function getCacheStats(): Promise<CacheStats> {
  try {
    const db = await openDb();
    const rows = await getAllRows(db);
    return {
      entryCount: rows.length,
      totalBytes: rows.reduce((s, r) => s + (r.size || 0), 0),
      maxBytes: MAX_CACHE_BYTES,
      maxEntries: MAX_CACHE_ENTRIES,
    };
  } catch {
    return {
      entryCount: 0,
      totalBytes: 0,
      maxBytes: MAX_CACHE_BYTES,
      maxEntries: MAX_CACHE_ENTRIES,
    };
  }
}

export async function putOfflineBlob(
  id: string,
  blob: Blob,
  meta: { name: string; mimeType: string; size: number; sha256?: string }
): Promise<{ evictedIds: string[] }> {
  const db = await openDb();
  const size = meta.size || blob.size || 0;
  if (size > MAX_CACHE_BYTES) {
    throw new Error(
      'File larger than offline cache quota (' +
        Math.round(MAX_CACHE_BYTES / 1024 / 1024) +
        ' MB)'
    );
  }
  const evictedIds = await enforceQuota(db, size, id);

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put({
      id,
      blob,
      name: meta.name,
      mimeType: meta.mimeType,
      size,
      sha256: meta.sha256,
      cachedAt: new Date().toISOString(),
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  return { evictedIds };
}

export async function getOfflineBlob(id: string): Promise<Blob | null> {
  try {
    const db = await openDb();
    const row = await new Promise<any>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    if (!row?.blob) return null;
    // True LRU: refresh cachedAt on access (best-effort)
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put({ ...row, cachedAt: new Date().toISOString() });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (e) {
      console.warn('[offlineCache] LRU touch failed for', id, e);
    }
    return row.blob as Blob;
  } catch (e) {
    console.warn('[offlineCache] getOfflineBlob failed:', id, e);
    return null;
  }
}

export async function removeOfflineBlob(id: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('Failed to remove offline blob'));
  });
}

export async function clearOfflineCache(): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function listOfflineMeta(): Promise<OfflineBlobMeta[]> {
  try {
    const db = await openDb();
    const rows = await getAllRows(db);
    return rows.map((r: any) => ({
      id: r.id,
      name: r.name,
      mimeType: r.mimeType,
      size: r.size,
      cachedAt: r.cachedAt,
      sha256: r.sha256,
    }));
  } catch {
    return [];
  }
}

export async function sha256Blob(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

const NATIVE_EXPORT: Record<string, { exportMime: string; ext: string }> = {
  'application/vnd.google-apps.document': {
    exportMime: 'application/pdf',
    ext: '.pdf',
  },
  'application/vnd.google-apps.spreadsheet': {
    exportMime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ext: '.xlsx',
  },
  'application/vnd.google-apps.presentation': {
    exportMime: 'application/pdf',
    ext: '.pdf',
  },
  'application/vnd.google-apps.drawing': {
    exportMime: 'image/png',
    ext: '.png',
  },
};

export function getNativeExportHint(mimeType: string): { exportMime: string; ext: string } | null {
  return NATIVE_EXPORT[mimeType] || null;
}

export async function downloadDriveFileBytes(
  accessToken: string,
  fileId: string,
  mimeType: string,
  opts?: { signal?: AbortSignal }
): Promise<{ blob: Blob; downloadName?: string }> {
  const native = NATIVE_EXPORT[mimeType];
  const headers = { Authorization: 'Bearer ' + accessToken };
  if (native) {
    const res = await fetchWithBackoff(
      `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=${encodeURIComponent(native.exportMime)}`,
      { headers, signal: opts?.signal },
      { label: 'files.export', maxRetries: 4, baseMs: 400 }
    );
    if (!res.ok) throw new Error('Export failed: ' + res.status);
    return { blob: await res.blob(), downloadName: native.ext };
  }

  const res = await fetchWithBackoff(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`,
    { headers, signal: opts?.signal },
    { label: 'files.download', maxRetries: 4, baseMs: 400 }
  );
  if (!res.ok) throw new Error('Download failed: ' + res.status);
  return { blob: await res.blob() };
}
