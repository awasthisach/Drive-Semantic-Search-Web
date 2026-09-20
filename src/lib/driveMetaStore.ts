/**
 * Durable Drive metadata snapshot in IndexedDB (survives refresh).
 */
import type { DriveFile, FolderItem } from '../types';

const DB_NAME = 'drive-semantic-meta';
const DB_VERSION = 1;
const STORE = 'snapshot';

export interface DriveMetaSnapshot {
  key: string;
  files: DriveFile[];
  folders: FolderItem[];
  corpus: string;
  sharedDriveId?: string;
  savedAt: string;
  truncated?: boolean;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'key' });
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
  const snap: DriveMetaSnapshot = {
    key: 'latest',
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
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadDriveMetaSnapshot(): Promise<DriveMetaSnapshot | null> {
  try {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get('latest');
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    console.warn('[driveMetaStore] load failed', e);
    return null;
  }
}
