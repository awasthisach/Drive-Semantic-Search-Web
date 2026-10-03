/**
 * Durable Drive metadata snapshot in IndexedDB (survives refresh).
 * Keys are per-corpus so My Drive / Shared Drive caches do not overwrite each other.
 * Also stores Changes API page tokens for incremental sync.
 */
import type { DriveFile, FolderItem } from '../types';

const DB_NAME = 'drive-semantic-meta';
const DB_VERSION = 2;
const STORE = 'snapshot';
const TOKEN_STORE = 'pageTokens';

export interface DriveMetaSnapshot {
  key: string;
  files: DriveFile[];
  folders: FolderItem[];
  corpus: string;
  sharedDriveId?: string;
  savedAt: string;
  truncated?: boolean;
}

function snapshotKey(corpus: string, sharedDriveId?: string): string {
  if (corpus === 'drive' && sharedDriveId) return 'drive:' + sharedDriveId;
  if (corpus === 'allDrives') return 'allDrives';
  return 'user';
}

function tokenKey(corpus: string, sharedDriveId?: string): string {
  return 'changes:' + snapshotKey(corpus, sharedDriveId);
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB not available'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error || new Error('meta db open failed'));
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(TOKEN_STORE)) {
        db.createObjectStore(TOKEN_STORE, { keyPath: 'key' });
      }
    };
  });
}

export async function saveDriveMetaSnapshot(
  files: DriveFile[],
  folders: FolderItem[],
  meta: { corpus: string; sharedDriveId?: string; truncated?: boolean }
): Promise<void> {
  const db = await openDb();
  const key = snapshotKey(meta.corpus, meta.sharedDriveId);
  const snap: DriveMetaSnapshot = {
    key,
    files: files.filter(f => f.isGoogleDriveItem),
    folders,
    corpus: meta.corpus,
    sharedDriveId: meta.sharedDriveId,
    truncated: meta.truncated,
    savedAt: new Date().toISOString(),
  };
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(snap);
    tx.objectStore(STORE).put({ ...snap, key: 'latest' });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadDriveMetaSnapshot(
  corpus?: string,
  sharedDriveId?: string
): Promise<DriveMetaSnapshot | null> {
  try {
    const db = await openDb();
    const key =
      corpus !== undefined ? snapshotKey(corpus, sharedDriveId) : 'latest';
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => {
        if (req.result) {
          resolve(req.result);
          return;
        }
        // Only fall back to "latest" for legacy/no-corpus callers.
        // Explicit corpus request must not leak another corpus's snapshot.
        if (corpus === undefined) {
          const legacy = tx.objectStore(STORE).get('latest');
          legacy.onsuccess = () => resolve(legacy.result || null);
          legacy.onerror = () => resolve(null);
          return;
        }
        resolve(null);
      };
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    console.warn('[driveMetaStore] load failed', e);
    return null;
  }
}

/** Strict backup export of all corpus snapshots; sync page tokens are not included. */
export async function exportDriveMetaSnapshotsForBackup(): Promise<DriveMetaSnapshot[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
    req.onsuccess = () => resolve(((req.result || []) as DriveMetaSnapshot[]).filter(row => row.key !== 'latest'));
    req.onerror = () => reject(req.error || new Error('Could not read Drive metadata for backup'));
  });
}

/** Merge Drive snapshots and drop local change tokens so the next sync safely refreshes them. */
export async function restoreDriveMetaSnapshotsFromBackup(
  snapshots: DriveMetaSnapshot[]
): Promise<number> {
  if (!snapshots.length) return 0;
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE, TOKEN_STORE], 'readwrite');
    const store = tx.objectStore(STORE);
    const tokens = tx.objectStore(TOKEN_STORE);
    let latest = snapshots[0];
    for (const snapshot of snapshots) {
      const key = snapshotKey(snapshot.corpus, snapshot.sharedDriveId);
      const restored = { ...snapshot, key };
      store.put(restored);
      tokens.delete(tokenKey(snapshot.corpus, snapshot.sharedDriveId));
      if ((snapshot.savedAt || '') > (latest.savedAt || '')) latest = snapshot;
    }
    store.put({ ...latest, key: 'latest' });
    tx.oncomplete = () => resolve(snapshots.length);
    tx.onerror = () => reject(tx.error || new Error('Could not restore Drive metadata'));
    tx.onabort = () => reject(tx.error || new Error('Drive metadata restore was aborted'));
  });
}

export async function saveChangesPageToken(
  corpus: string,
  sharedDriveId: string | undefined,
  pageToken: string
): Promise<void> {
  const db = await openDb();
  if (!db.objectStoreNames.contains(TOKEN_STORE)) return;
  const key = tokenKey(corpus, sharedDriveId);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TOKEN_STORE, 'readwrite');
    tx.objectStore(TOKEN_STORE).put({ key, pageToken, savedAt: new Date().toISOString() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadChangesPageToken(
  corpus: string,
  sharedDriveId?: string
): Promise<string | null> {
  try {
    const db = await openDb();
    if (!db.objectStoreNames.contains(TOKEN_STORE)) return null;
    const key = tokenKey(corpus, sharedDriveId);
    return new Promise((resolve, reject) => {
      const req = db.transaction(TOKEN_STORE, 'readonly').objectStore(TOKEN_STORE).get(key);
      req.onsuccess = () => resolve(req.result?.pageToken || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

export async function clearChangesPageToken(
  corpus: string,
  sharedDriveId?: string
): Promise<void> {
  try {
    const db = await openDb();
    if (!db.objectStoreNames.contains(TOKEN_STORE)) return;
    const key = tokenKey(corpus, sharedDriveId);
    return new Promise((resolve, reject) => {
      const tx = db.transaction(TOKEN_STORE, 'readwrite');
      tx.objectStore(TOKEN_STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* ignore */
  }
}
