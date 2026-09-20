import { DriveFile, FolderItem } from '../types';
import { getCategoryFromMime } from './driveApi';
import { fetchWithBackoff } from './rateLimit';

const FOLDER_COLORS = ['blue', 'emerald', 'purple', 'amber', 'rose', 'indigo', 'cyan', 'zinc'];

export interface DriveFetchResult {
  files: DriveFile[];
  folders: FolderItem[];
  truncated: boolean;
  pagesFetched: number;
}

export type DriveFileTypeFilter = 'all' | 'documents' | 'images' | 'videos' | 'spreadsheets' | 'pdfs' | 'folders';

/** Drive list corpus — My Drive, all drives, or a specific Shared Drive */
export type DriveCorpus = 'user' | 'allDrives' | 'drive';

export interface SharedDriveInfo {
  id: string;
  name: string;
}

export async function listSharedDrives(accessToken: string): Promise<SharedDriveInfo[]> {
  const drives: SharedDriveInfo[] = [];
  let pageToken: string | undefined;
  for (let i = 0; i < 40; i++) {
    const params = new URLSearchParams({
      pageSize: '50',
      fields: 'nextPageToken,drives(id,name)',
    });
    if (pageToken) params.set('pageToken', pageToken);
    const res = await fetchWithBackoff(
      `https://www.googleapis.com/drive/v3/drives?${params.toString()}`,
      { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } },
      { label: 'listSharedDrives', maxRetries: 4, baseMs: 400 }
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.error?.message || `List shared drives failed: ${res.status}`);
    }
    const data = await res.json();
    for (const d of data.drives || []) {
      drives.push({ id: d.id, name: d.name });
    }
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }
  return drives;
}

function buildDriveQuery(fileType: DriveFileTypeFilter = 'all'): string {
  const base = "trashed=false and mimeType!='application/vnd.google-apps.shortcut'";
  switch (fileType) {
    case 'documents':
      return `${base} and (mimeType='application/pdf' or mimeType='application/msword' or mimeType='application/vnd.openxmlformats-officedocument.wordprocessingml.document' or mimeType='application/vnd.google-apps.document' or mimeType='text/plain' or mimeType='application/rtf')`;
    case 'pdfs':
      return `${base} and mimeType='application/pdf'`;
    case 'images':
      return `${base} and (mimeType contains 'image/' or mimeType='application/vnd.google-apps.photo')`;
    case 'videos':
      return `${base} and (mimeType contains 'video/' or mimeType='application/vnd.google-apps.video')`;
    case 'spreadsheets':
      return `${base} and (mimeType='application/vnd.ms-excel' or mimeType='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' or mimeType='application/vnd.google-apps.spreadsheet' or mimeType='text/csv')`;
    case 'folders':
      return `${base} and mimeType='application/vnd.google-apps.folder'`;
    default:
      return base;
  }
}

export async function fetchGoogleDriveData(
  accessToken: string,
  fileType: DriveFileTypeFilter = 'all',
  maxPages: number = 40,
  corpus: DriveCorpus = 'user',
  driveId?: string
): Promise<DriveFetchResult> {
  if (!accessToken || typeof accessToken !== 'string') {
    throw new Error('fetchGoogleDriveData: accessToken is required');
  }
  const allowedTypes: DriveFileTypeFilter[] = ['all', 'documents', 'images', 'videos', 'spreadsheets', 'pdfs', 'folders'];
  if (!allowedTypes.includes(fileType)) {
    throw new Error('fetchGoogleDriveData: invalid fileType');
  }
  if (!Number.isFinite(maxPages) || maxPages < 1 || maxPages > 100) {
    throw new Error('fetchGoogleDriveData: maxPages must be 1–100');
  }
  const allowedCorpus: DriveCorpus[] = ['user', 'allDrives', 'drive'];
  if (!allowedCorpus.includes(corpus)) {
    throw new Error('fetchGoogleDriveData: invalid corpus');
  }
  if (corpus === 'drive' && !driveId) {
    throw new Error('fetchGoogleDriveData: driveId required when corpus is drive');
  }
  const fields = 'files(id,name,mimeType,size,modifiedTime,createdTime,thumbnailLink,webViewLink,iconLink,parents,trashed,description,starred),nextPageToken';
  const query = buildDriveQuery(fileType);
  const rawItems: any[] = [];
  let pageToken: string | undefined;
  let pagesFetched = 0;

  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({
      pageSize: '500',
      fields,
      q: query,
      orderBy: 'modifiedTime desc',
      supportsAllDrives: 'true',
    });
    if (corpus === 'allDrives') {
      params.set('corpora', 'allDrives');
      params.set('includeItemsFromAllDrives', 'true');
    } else if (corpus === 'drive' && driveId) {
      params.set('corpora', 'drive');
      params.set('driveId', driveId);
      params.set('includeItemsFromAllDrives', 'true');
    } else {
      params.set('corpora', 'user');
    }
    if (pageToken) params.set('pageToken', pageToken);

    const response = await fetchWithBackoff(
      `https://www.googleapis.com/drive/v3/files?${params.toString()}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
        },
      },
      { label: 'files.list', maxRetries: 5, baseMs: 500 }
    );

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData?.error?.message || `Google Drive API error: ${response.status}`);
    }

    const data = await response.json();
    rawItems.push(...(data.files || []));
    pagesFetched = page + 1;
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }

  const truncated = Boolean(pageToken);
  const folders: FolderItem[] = [];
  const files: DriveFile[] = [];
  let colorIdx = 0;

  for (const item of rawItems) {
    if (item.mimeType === 'application/vnd.google-apps.folder') {
      folders.push({
        id: item.id,
        name: item.name,
        color: FOLDER_COLORS[colorIdx % FOLDER_COLORS.length],
        description: item.description || `Google Drive folder with ${item.name}`,
        createdAt: item.createdTime,
      });
      colorIdx++;
    } else {
      const category = getCategoryFromMime(item.mimeType || '', item.name || '');
      const primaryParent = item.parents && item.parents.length > 0 ? item.parents[0] : undefined;
      files.push({
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
      });
    }
  }

  return { files, folders, truncated, pagesFetched };
}

export async function moveGoogleDriveFile(
  accessToken: string,
  fileId: string,
  newFolderId: string,
  currentParentIds: string[] = []
): Promise<void> {
  let previousParents = currentParentIds.join(',');
  if (!previousParents) {
    const metaRes = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?fields=parents&supportsAllDrives=true`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (metaRes.ok) {
      const meta = await metaRes.json();
      previousParents = (meta.parents || []).join(',');
    }
  }
  const params = new URLSearchParams();
  if (newFolderId && newFolderId !== 'root') params.set('addParents', newFolderId);
  if (previousParents) params.set('removeParents', previousParents);
  params.set('fields', 'id,parents');
  params.set('supportsAllDrives', 'true');
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?${params.toString()}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    }
  );
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData?.error?.message || `Failed to move file: ${response.status}`);
  }
}

export async function createGoogleDriveFolder(
  accessToken: string,
  name: string
): Promise<{ id: string; name: string }> {
  const response = await fetch('https://www.googleapis.com/drive/v3/files?supportsAllDrives=true', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name,
      mimeType: 'application/vnd.google-apps.folder',
    }),
  });
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData?.error?.message || `Failed to create folder: ${response.status}`);
  }
  return response.json();
}

export async function deleteGoogleDriveFile(
  accessToken: string,
  fileId: string
): Promise<void> {
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?supportsAllDrives=true`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ trashed: true }),
    }
  );
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData?.error?.message || `Failed to trash file: ${response.status}`);
  }
}

export async function starGoogleDriveFile(
  accessToken: string,
  fileId: string,
  starred: boolean
): Promise<void> {
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?supportsAllDrives=true`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ starred }),
    }
  );
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData?.error?.message || `Failed to update star: ${response.status}`);
  }
}

export async function uploadGoogleDriveFile(
  accessToken: string,
  file: File,
  parentFolderId?: string
): Promise<DriveFile> {
  const metadata: Record<string, unknown> = {
    name: file.name,
    mimeType: file.type || 'application/octet-stream',
  };
  if (parentFolderId && parentFolderId !== 'root') {
    metadata.parents = [parentFolderId];
  }

  const boundary = '-------driveBoundary' + Date.now();
  const delimiter = '\r\n--' + boundary + '\r\n';
  const closeDelim = '\r\n--' + boundary + '--';
  const metaPart =
    delimiter +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify(metadata);
  const fileHeader =
    delimiter +
    'Content-Type: ' + (file.type || 'application/octet-stream') + '\r\n\r\n';
  const body = new Blob([
    new Blob([metaPart]),
    new Blob([fileHeader]),
    file,
    new Blob([closeDelim]),
  ]);

  const response = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,size,modifiedTime,createdTime,webViewLink,iconLink,parents,thumbnailLink&supportsAllDrives=true',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + accessToken,
        'Content-Type': 'multipart/related; boundary=' + boundary,
      },
      body,
    }
  );

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData?.error?.message || 'Upload failed: ' + response.status);
  }

  const item = await response.json();
  const category = getCategoryFromMime(item.mimeType || file.type || '', item.name || file.name);
  const primaryParent = item.parents && item.parents.length > 0 ? item.parents[0] : undefined;

  return {
    id: item.id,
    name: item.name,
    mimeType: item.mimeType || file.type || 'application/octet-stream',
    size: item.size ? parseInt(item.size, 10) : file.size,
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
    contentHash: 'gdrive-' + item.id + '-' + (item.size || file.size),
    tags: ['google-drive', 'uploaded', category],
    semanticSummary: 'Uploaded to Google Drive: ' + item.name,
    starred: false,
  };
}
