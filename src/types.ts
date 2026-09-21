export type FileCategory = 'document' | 'image' | 'spreadsheet' | 'code' | 'archive' | 'audio' | 'video' | 'other';
export type DriveSyncStatus = 'synced' | 'syncing' | 'pending' | 'offline_only' | 'error';

export interface FolderItem {
  id: string;
  name: string;
  color: string;
  description?: string;
  createdAt?: string;
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size: number; // bytes
  modifiedTime: string;
  createdTime: string;
  category: FileCategory;
  folderId?: string; // Target folder identifier
  thumbnailUrl?: string;
  webViewLink?: string;
  iconLink?: string;
  parentIds?: string[];
  isGoogleDriveItem?: boolean;
  isOffline: boolean;
  isEncrypted: boolean;
  contentHash: string;
  tags: string[];
  semanticSummary: string;
  starred?: boolean;
}

export interface VaultFile {
  id: string;
  name: string;
  originalName: string;
  size: number;
  mimeType: string;
  encryptedData: string; // Base64 ciphertext
  iv: string; // Base64 IV
  salt: string; // Base64 salt
  uploadedAt: string;
  tags: string[];
  notes?: string;
}

export interface DuplicateGroup {
  hash: string;
  fileCount: number;
  totalSize: number;
  reclaimableSize: number;
  files: DriveFile[];
}

export interface SemanticSearchResult {
  file: DriveFile;
  score: number; // 0 - 100
  matchedSnippet: string;
  relevanceReason: string;
}

export interface SyncStats {
  status: DriveSyncStatus;
  lastSynced: string;
  pendingCount: number;
  totalSyncedCount: number;
  bandwidthUsage: string;
  networkOnline: boolean;
}

export type AppTab = 'dashboard' | 'storage_scanner' | 'vault' | 'duplicates' | 'search' | 'offline';

export type StorageSource = 'phone_internal' | 'sd_card';

export interface DeviceStorageFile {
  id: string;
  name: string;
  path: string;
  source: StorageSource; // 'phone_internal' (फ़ोन मेमोरी) | 'sd_card' (SD कार्ड)
  size: number;
  mimeType: string;
  category: FileCategory;
  lastModified: string;
  isLargeFile?: boolean;
  isDuplicate?: boolean;
  duplicateGroupHash?: string;
  isCacheOrJunk?: boolean;
  thumbnailUrl?: string;
  rawFileRef?: File;
}

export interface StorageDeviceStats {
  source: StorageSource;
  label: string;
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  fileCount: number;
  health: 'healthy' | 'warning' | 'critical';
}
