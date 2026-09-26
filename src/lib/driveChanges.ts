/**
 * Google Drive Changes API — incremental sync after initial full list.
 * https://developers.google.com/drive/api/guides/manage-changes
 */

import type { DriveFile, FolderItem } from '../types';
import { getCategoryFromMime } from './driveApi';
import { fetchWithBackoff } from './rateLimit';
import type { DriveCorpus } from './googleDriveService';

const FOLDER_COLORS = ['blue', 'emerald', 'purple', 'amber', 'rose', 'indigo', 'cyan', 'zinc'];

export async function getChangesStartPageToken(
  accessToken: string,
  corpus: DriveCorpus = 'user',
  driveId?: string
): Promise<string> {
  const params = new URLSearchParams({ supportsAllDrives: 'true' });
  if (corpus === 'drive' && driveId) {
    params.set('driveId', driveId);
  }
  const res = await fetchWithBackoff(
    `https://www.googleapis.com/drive/v3/changes/startPageToken?${params}`,
    { headers: { Authorization: 'Bearer ' + accessToken, Accept: 'application/json' } },
    { label: 'startPageToken', maxRetries: 4, baseMs: 500 }
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || 'startPageToken failed: ' + res.status);
  }
  const data = await res.json();
  return data.startPageToken as string;
}

export interface DriveChangeItem {
  fileId: string;
  removed: boolean;
  file?: any;
}

export interface ChangesPageResult {
  changes: DriveChangeItem[];
  newStartPageToken?: string;
  nextPageToken?: string;
}

export async function listDriveChangesPage(
  accessToken: string,
  pageToken: string,
  corpus: DriveCorpus = 'user',
  driveId?: string
): Promise<ChangesPageResult> {
  const params = new URLSearchParams({
    pageToken,
    pageSize: '200',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: corpus === 'allDrives' || corpus === 'drive' ? 'true' : 'false',
    fields:
      'nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,mimeType,size,modifiedTime,createdTime,thumbnailLink,webViewLink,iconLink,parents,trashed,description,starred))',
  });
  if (corpus === 'drive' && driveId) {
    params.set('driveId', driveId);
    params.set('includeItemsFromAllDrives', 'true');
  } else if (corpus === 'allDrives') {
    params.set('includeItemsFromAllDrives', 'true');
    params.set('restrictToMyDrive', 'false');
  }

  const res = await fetchWithBackoff(
    `https://www.googleapis.com/drive/v3/changes?${params}`,
    { headers: { Authorization: 'Bearer ' + accessToken, Accept: 'application/json' } },
    { label: 'changes.list', maxRetries: 4, baseMs: 500 }
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || 'changes.list failed: ' + res.status);
  }
  const data = await res.json();
  const changes: DriveChangeItem[] = (data.changes || []).map((c: any) => ({
    fileId: c.fileId,
    removed: Boolean(c.removed || c.file?.trashed),
    file: c.file,
  }));
  return {
    changes,
    newStartPageToken: data.newStartPageToken,
    nextPageToken: data.nextPageToken,
  };
}

/** Drain all change pages until newStartPageToken is returned. */
export async function listAllDriveChanges(
  accessToken: string,
  pageToken: string,
  corpus: DriveCorpus = 'user',
  driveId?: string,
  maxPages: number = 500
): Promise<{ changes: DriveChangeItem[]; newPageToken: string }> {
  let token = pageToken;
  const all: DriveChangeItem[] = [];
  let newPageToken = pageToken;
  for (let i = 0; i < maxPages; i++) {
    const page = await listDriveChangesPage(accessToken, token, corpus, driveId);
    all.push(...page.changes);
    if (page.newStartPageToken) {
      newPageToken = page.newStartPageToken;
      break;
    }
    if (page.nextPageToken) {
      token = page.nextPageToken;
      continue;
    }
    break;
  }
  return { changes: all, newPageToken };
}

function mapApiFile(item: any, colorIdx = 0): { kind: 'folder'; folder: FolderItem } | { kind: 'file'; file: DriveFile } {
  if (item.mimeType === 'application/vnd.google-apps.folder') {
    return {
      kind: 'folder',
      folder: {
        id: item.id,
        name: item.name,
        color: FOLDER_COLORS[colorIdx % FOLDER_COLORS.length],
        description: item.description || `Google Drive folder with ${item.name}`,
        createdAt: item.createdTime,
      },
    };
  }
  if (item.mimeType === 'application/vnd.google-apps.shortcut') {
    return {
      kind: 'file',
      file: {
        id: item.id,
        name: item.name || 'shortcut',
        mimeType: item.mimeType,
        size: 0,
        modifiedTime: item.modifiedTime || new Date().toISOString(),
        createdTime: item.createdTime || new Date().toISOString(),
        category: 'other',
        isGoogleDriveItem: true,
        isOffline: false,
        isEncrypted: false,
        contentHash: 'gdrive-' + item.id,
        tags: ['google-drive', 'shortcut'],
        semanticSummary: 'Shortcut (excluded from primary corpus)',
        starred: Boolean(item.starred),
      },
    };
  }
  const category = getCategoryFromMime(item.mimeType || '', item.name || '');
  const primaryParent = item.parents && item.parents.length > 0 ? item.parents[0] : undefined;
  return {
    kind: 'file',
    file: {
      id: item.id,
      name: item.name,
      mimeType: item.mimeType || 'application/octet-stream',
      size: item.size ? parseInt(item.size, 10) : 0,
      modifiedTime: item.modifiedTime || new Date().toISOString(),
      createdTime: item.createdTime || new Date().toISOString(),
      category,
      folderId: primaryParent,
      thumbnailUrl: item.thumbnailLink,
      webViewLink: item.webViewLink,
      iconLink: item.iconLink,
      parentIds: item.parents || [],
      isGoogleDriveItem: true,
      isOffline: false,
      isEncrypted: false,
      contentHash: `gdrive-${item.id}-${item.size || 0}`,
      tags: ['google-drive', category, primaryParent ? 'categorized' : 'root'],
      semanticSummary: item.description || `Google Drive file "${item.name}" of type ${item.mimeType}`,
      starred: Boolean(item.starred),
    },
  };
}

/**
 * Apply change list onto existing files/folders arrays (immutable-style new arrays).
 */
export function applyDriveChanges(
  files: DriveFile[],
  folders: FolderItem[],
  changes: DriveChangeItem[]
): { files: DriveFile[]; folders: FolderItem[]; added: number; updated: number; removed: number; removedIds: string[] } {
  const fileMap = new Map(files.filter(f => f.isGoogleDriveItem).map(f => [f.id, f]));
  const localOnly = files.filter(f => !f.isGoogleDriveItem);
  const folderMap = new Map(folders.map(f => [f.id, f]));
  let added = 0;
  let updated = 0;
  let removed = 0;
  const removedIds: string[] = [];

  for (const ch of changes) {
    if (ch.removed || ch.file?.trashed) {
      if (fileMap.delete(ch.fileId)) {
        removed++;
        removedIds.push(ch.fileId);
      }
      if (folderMap.delete(ch.fileId)) removed++;
      continue;
    }
    if (!ch.file) continue;
    if (ch.file.mimeType === 'application/vnd.google-apps.shortcut') {
      fileMap.delete(ch.fileId);
      continue;
    }
    const mapped = mapApiFile(ch.file, folderMap.size);
    if (mapped.kind === 'folder') {
      if (folderMap.has(mapped.folder.id)) updated++;
      else added++;
      folderMap.set(mapped.folder.id, mapped.folder);
    } else {
      if (fileMap.has(mapped.file.id)) updated++;
      else added++;
      const prev = fileMap.get(mapped.file.id);
      if (prev) {
        mapped.file.isOffline = prev.isOffline;
        mapped.file.contentHash = prev.contentHash?.startsWith('sha256:')
          ? prev.contentHash
          : mapped.file.contentHash;
      }
      fileMap.set(mapped.file.id, mapped.file);
    }
  }

  return {
    files: [...fileMap.values(), ...localOnly],
    folders: [...folderMap.values()],
    added,
    updated,
    removed,
    removedIds,
  };
}
