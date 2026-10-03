import type { DriveFile, FolderItem, VaultFile } from '../types';
import {
  exportIndexedDocumentsForBackup,
  putIndexedDocument,
  type IndexedDocument,
} from './contentIndex';
import {
  exportVectorRecordsForBackup,
  removeVectorsForFile,
  restoreVectorRecordsFromBackup,
  type VectorRecord,
} from './vectorIndex';
import {
  exportVaultFilesForBackup,
  saveVaultFile,
} from './vaultStore';
import {
  exportDriveMetaSnapshotsForBackup,
  restoreDriveMetaSnapshotsFromBackup,
  type DriveMetaSnapshot,
} from './driveMetaStore';

const APP_ID = 'Drive Semantic Search Web';
const FORMAT_VERSION = 1;
const MAGIC = 'DSSBACK1';
const KDF_ITERATIONS = 310_000;
const MAX_FILE_BYTES = 160 * 1024 * 1024;
const MAX_PAYLOAD_BYTES = 128 * 1024 * 1024;
const MAX_DOCUMENTS = 50_000;
const MAX_VECTORS = 100_000;
const MAX_SNAPSHOTS = 100;
const MAX_DRIVE_FILES = 50_000;
const MAX_FOLDERS = 20_000;
const MAX_VAULT_ITEMS = 10_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export interface LocalBackupPayload {
  app: typeof APP_ID;
  formatVersion: 1;
  createdAt: string;
  documents: IndexedDocument[];
  vectors: VectorRecord[];
  vaultFiles: VaultFile[];
  driveSnapshots: DriveMetaSnapshot[];
}

export interface LocalBackupSummary {
  createdAt: string;
  documentCount: number;
  vectorCount: number;
  vaultItemCount: number;
  driveSnapshotCount: number;
  driveFileCount: number;
  folderCount: number;
}

export interface LocalRestoreResult {
  documents: number;
  vectors: number;
  vaultItems: number;
  driveSnapshots: number;
}

function requireCompressionSupport(): void {
  if (typeof CompressionStream === 'undefined' || typeof DecompressionStream === 'undefined') {
    throw new Error('This browser does not support secure backup compression. Update to a modern browser and try again.');
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const step = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += step) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + step, bytes.length)));
  }
  return btoa(binary);
}

function base64ToBytes(value: string, expectedLength?: number): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new Error('Backup encryption metadata is malformed.');
  }
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  if (expectedLength !== undefined && bytes.length !== expectedLength) {
    throw new Error('Backup encryption metadata has an invalid length.');
  }
  return bytes;
}

function arrayBufferFrom(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function transformGzip(input: Uint8Array, mode: 'compress' | 'decompress'): Promise<Uint8Array> {
  requireCompressionSupport();
  const stream = new Blob([arrayBufferFrom(input)]).stream().pipeThrough(
    mode === 'compress' ? new CompressionStream('gzip') : new DecompressionStream('gzip'),
  );
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    const limit = mode === 'compress' ? MAX_FILE_BYTES : MAX_PAYLOAD_BYTES;
    if (total > limit) {
      await reader.cancel();
      throw new Error(mode === 'compress'
        ? 'The encrypted backup would be too large for this browser to create safely.'
        : 'The backup expands beyond the safe restore size limit.');
    }
    parts.push(value);
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

async function deriveBackupKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: KDF_ITERATIONS, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

function estimatePayloadBytes(payload: LocalBackupPayload): number {
  // Conservative preflight estimate prevents a huge JSON allocation on low-memory devices.
  let total = 1024;
  for (const doc of payload.documents) total += doc.text.length * 4 + doc.name.length * 8 + 2048;
  for (const vector of payload.vectors) {
    total += vector.embedding.length * 16 + vector.text.length * 4 + 2048;
    if (total > MAX_PAYLOAD_BYTES) return total;
  }
  for (const file of payload.vaultFiles) total += file.encryptedData.length + file.iv.length + file.salt.length + 2048;
  for (const snapshot of payload.driveSnapshots) {
    total += snapshot.files.length * 4096 + snapshot.folders.length * 512 + 4096;
  }
  return total;
}

function summarize(payload: LocalBackupPayload): LocalBackupSummary {
  return {
    createdAt: payload.createdAt,
    documentCount: payload.documents.length,
    vectorCount: payload.vectors.length,
    vaultItemCount: payload.vaultFiles.length,
    driveSnapshotCount: payload.driveSnapshots.length,
    driveFileCount: payload.driveSnapshots.reduce((sum, item) => sum + item.files.length, 0),
    folderCount: payload.driveSnapshots.reduce((sum, item) => sum + item.folders.length, 0),
  };
}

function validatePayload(value: unknown): LocalBackupPayload {
  if (!value || typeof value !== 'object') throw new Error('Backup contents are not a valid object.');
  const payload = value as Partial<LocalBackupPayload>;
  if (payload.app !== APP_ID || payload.formatVersion !== FORMAT_VERSION || typeof payload.createdAt !== 'string') {
    throw new Error('This backup is not compatible with this app version.');
  }
  if (!Array.isArray(payload.documents) || !Array.isArray(payload.vectors) ||
      !Array.isArray(payload.vaultFiles) || !Array.isArray(payload.driveSnapshots)) {
    throw new Error('Backup is missing one or more required data sections.');
  }
  if (payload.documents.length > MAX_DOCUMENTS || payload.vectors.length > MAX_VECTORS ||
      payload.vaultFiles.length > MAX_VAULT_ITEMS || payload.driveSnapshots.length > MAX_SNAPSHOTS) {
    throw new Error('Backup contains more records than this app can safely restore.');
  }

  const documentIds = new Set<string>();
  for (const doc of payload.documents) {
    if (!doc || typeof doc.id !== 'string' || !doc.id || typeof doc.name !== 'string' ||
        typeof doc.mimeType !== 'string' || typeof doc.text !== 'string' ||
        doc.text.length > 500_000 || !['export', 'binary-text', 'offline-blob'].includes(doc.source) ||
        (doc.corpusKey !== undefined && typeof doc.corpusKey !== 'string')) {
      throw new Error('Backup contains an invalid indexed-document record.');
    }
    if (documentIds.has(doc.id)) throw new Error('Backup contains duplicate indexed-document IDs.');
    documentIds.add(doc.id);
  }

  const vectorIds = new Set<string>();
  const docsById = new Map(payload.documents.map(doc => [doc.id, doc]));
  for (const vector of payload.vectors) {
    if (!vector || typeof vector.id !== 'string' || typeof vector.fileId !== 'string' ||
        !Number.isInteger(vector.idx) || vector.idx < 0 || typeof vector.corpusKey !== 'string' ||
        typeof vector.embeddingModel !== 'string' || typeof vector.embeddingVersion !== 'string' ||
        !Number.isInteger(vector.dimension) || vector.dimension < 1 || vector.dimension > 4096 ||
        !Array.isArray(vector.embedding) || vector.embedding.length !== vector.dimension ||
        vector.embedding.some(value => typeof value !== 'number' || !Number.isFinite(value)) ||
        typeof vector.text !== 'string' || vector.text.length > 2000 ||
        typeof vector.contentHash !== 'string' || typeof vector.indexedAt !== 'string') {
      throw new Error('Backup contains an invalid semantic-vector record.');
    }
    if (vector.id !== `${vector.corpusKey}::${vector.fileId}#${vector.idx}`) {
      throw new Error('Backup contains a vector with an invalid record key.');
    }
    if (vectorIds.has(vector.id)) throw new Error('Backup contains duplicate semantic-vector IDs.');
    vectorIds.add(vector.id);
    const doc = docsById.get(vector.fileId);
    if (!doc || (doc.corpusKey || 'user') !== vector.corpusKey) {
      throw new Error('Backup contains semantic vectors without a matching indexed document.');
    }
  }

  const vaultIds = new Set<string>();
  for (const item of payload.vaultFiles) {
    if (!item || typeof item.id !== 'string' || !item.id || typeof item.name !== 'string' ||
        typeof item.originalName !== 'string' || typeof item.encryptedData !== 'string' ||
        typeof item.iv !== 'string' || typeof item.salt !== 'string' || !Array.isArray(item.tags) ||
        item.tags.some(tag => typeof tag !== 'string') || !Number.isFinite(item.size) ||
        typeof item.uploadedAt !== 'string') {
      throw new Error('Backup contains an invalid encrypted-vault record.');
    }
    if (vaultIds.has(item.id)) throw new Error('Backup contains duplicate vault item IDs.');
    vaultIds.add(item.id);
  }

  let driveFileCount = 0;
  let folderCount = 0;
  const snapshotKeys = new Set<string>();
  for (const snapshot of payload.driveSnapshots) {
    if (!snapshot || typeof snapshot.key !== 'string' || snapshot.key === 'latest' ||
        !['user', 'drive', 'allDrives'].includes(snapshot.corpus) || typeof snapshot.savedAt !== 'string' ||
        !Array.isArray(snapshot.files) || !Array.isArray(snapshot.folders)) {
      throw new Error('Backup contains an invalid Drive metadata snapshot.');
    }
    if (snapshot.corpus === 'drive' && (typeof snapshot.sharedDriveId !== 'string' || !snapshot.sharedDriveId)) {
      throw new Error('Backup contains a Shared Drive snapshot without a Drive ID.');
    }
    const expectedKey = snapshot.corpus === 'drive'
      ? `drive:${snapshot.sharedDriveId}`
      : snapshot.corpus;
    if (snapshot.key !== expectedKey) throw new Error('Backup contains a mismatched Drive snapshot key.');
    if (snapshotKeys.has(snapshot.key)) throw new Error('Backup contains duplicate Drive metadata snapshots.');
    snapshotKeys.add(snapshot.key);
    driveFileCount += snapshot.files.length;
    folderCount += snapshot.folders.length;
    for (const file of snapshot.files as DriveFile[]) {
      if (!file || typeof file.id !== 'string' || typeof file.name !== 'string' ||
          typeof file.mimeType !== 'string' || !Number.isFinite(file.size) ||
          typeof file.modifiedTime !== 'string' || typeof file.createdTime !== 'string' ||
          !['document', 'image', 'spreadsheet', 'code', 'archive', 'audio', 'video', 'other'].includes(file.category) ||
          file.isGoogleDriveItem !== true || typeof file.isOffline !== 'boolean' ||
          typeof file.isEncrypted !== 'boolean' || typeof file.contentHash !== 'string' ||
          typeof file.semanticSummary !== 'string' || !Array.isArray(file.tags) ||
          file.tags.some(tag => typeof tag !== 'string') ||
          (file.parentIds !== undefined && (!Array.isArray(file.parentIds) || file.parentIds.some(id => typeof id !== 'string')))) {
        throw new Error('Backup contains an invalid Drive file metadata record.');
      }
    }
    for (const folder of snapshot.folders as FolderItem[]) {
      if (!folder || typeof folder.id !== 'string' || typeof folder.name !== 'string' ||
          typeof folder.color !== 'string' || (folder.parentIds !== undefined &&
            (!Array.isArray(folder.parentIds) || folder.parentIds.some(parentId => typeof parentId !== 'string')))) {
        throw new Error('Backup contains an invalid Drive folder metadata record.');
      }
    }
  }
  if (driveFileCount > MAX_DRIVE_FILES || folderCount > MAX_FOLDERS) {
    throw new Error('Backup contains too many Drive metadata records to restore safely.');
  }
  return payload as LocalBackupPayload;
}

export async function createLocalBackupBlob(passphrase: string): Promise<Blob> {
  if (passphrase.length < 12) throw new Error('Use a backup passphrase of at least 12 characters.');
  requireCompressionSupport();
  const [documents, vectors, vaultFiles, driveSnapshots] = await Promise.all([
    exportIndexedDocumentsForBackup(),
    exportVectorRecordsForBackup(),
    exportVaultFilesForBackup(),
    exportDriveMetaSnapshotsForBackup(),
  ]);
  const payload: LocalBackupPayload = {
    app: APP_ID,
    formatVersion: FORMAT_VERSION,
    createdAt: new Date().toISOString(),
    documents,
    vectors,
    vaultFiles,
    driveSnapshots,
  };
  validatePayload(payload);
  if (estimatePayloadBytes(payload) > MAX_PAYLOAD_BYTES) {
    throw new Error('The local index is too large for a safe in-browser backup. Try backing up a smaller indexed corpus.');
  }
  const json = JSON.stringify(payload);
  const plainBytes = encoder.encode(json);
  if (plainBytes.byteLength > MAX_PAYLOAD_BYTES) {
    throw new Error('The backup exceeds the safe in-browser size limit.');
  }
  const compressed = await transformGzip(plainBytes, 'compress');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const header = {
    formatVersion: FORMAT_VERSION,
    createdAt: payload.createdAt,
    compression: 'gzip',
    kdf: 'PBKDF2-SHA-256',
    iterations: KDF_ITERATIONS,
    salt: bytesToBase64(salt),
    cipher: 'AES-GCM-256',
    iv: bytesToBase64(iv),
  };
  const headerBytes = encoder.encode(JSON.stringify(header));
  const key = await deriveBackupKey(passphrase, salt);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: headerBytes }, key, arrayBufferFrom(compressed),
  ));
  const output = new Uint8Array(12 + headerBytes.length + encrypted.length);
  output.set(encoder.encode(MAGIC), 0);
  new DataView(output.buffer).setUint32(8, headerBytes.length, false);
  output.set(headerBytes, 12);
  output.set(encrypted, 12 + headerBytes.length);
  if (output.byteLength > MAX_FILE_BYTES) throw new Error('The encrypted backup exceeds this browser’s safe file-size limit.');
  return new Blob([arrayBufferFrom(output)], { type: 'application/octet-stream' });
}

export async function inspectLocalBackup(file: Blob, passphrase: string): Promise<LocalBackupPayload> {
  if (!passphrase) throw new Error('Enter the backup passphrase.');
  if (file.size < 64 || file.size > MAX_FILE_BYTES) throw new Error('Backup file size is invalid or exceeds the safe restore limit.');
  requireCompressionSupport();
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (decoder.decode(bytes.subarray(0, 8)) !== MAGIC) throw new Error('This is not a Drive Semantic Search backup file.');
  const headerLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(8, false);
  if (headerLength < 2 || headerLength > 2048 || 12 + headerLength + 16 > bytes.length) {
    throw new Error('Backup header is malformed.');
  }
  const headerBytes = bytes.subarray(12, 12 + headerLength);
  let header: Record<string, unknown>;
  try {
    header = JSON.parse(decoder.decode(headerBytes)) as Record<string, unknown>;
  } catch {
    throw new Error('Backup header is not valid JSON.');
  }
  if (header.formatVersion !== FORMAT_VERSION || header.compression !== 'gzip' ||
      header.kdf !== 'PBKDF2-SHA-256' || header.iterations !== KDF_ITERATIONS ||
      header.cipher !== 'AES-GCM-256' || typeof header.createdAt !== 'string' ||
      typeof header.salt !== 'string' || typeof header.iv !== 'string') {
    throw new Error('This backup format or encryption profile is not supported.');
  }
  const salt = base64ToBytes(header.salt, 16);
  const iv = base64ToBytes(header.iv, 12);
  const key = await deriveBackupKey(passphrase, salt);
  let compressed: Uint8Array;
  try {
    compressed = new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: headerBytes },
      key,
      arrayBufferFrom(bytes.subarray(12 + headerLength)),
    ));
  } catch {
    throw new Error('Could not decrypt this backup. Check the passphrase and file integrity.');
  }
  const plainBytes = await transformGzip(compressed, 'decompress');
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(plainBytes));
  } catch {
    throw new Error('Decrypted backup contents are malformed.');
  }
  const payload = validatePayload(parsed);
  if (payload.createdAt !== header.createdAt) throw new Error('Backup metadata failed its integrity check.');
  return payload;
}

export function getLocalBackupSummary(payload: LocalBackupPayload): LocalBackupSummary {
  return summarize(payload);
}

/** Merge backup data by record key; unrelated local records are not deleted. */
export async function restoreLocalBackup(payload: LocalBackupPayload): Promise<LocalRestoreResult> {
  const validated = validatePayload(payload);
  for (const doc of validated.documents) {
    await putIndexedDocument({
      id: doc.id,
      name: doc.name,
      mimeType: doc.mimeType,
      text: doc.text,
      source: doc.source,
      driveModifiedTime: doc.driveModifiedTime,
      textTruncated: doc.textTruncated,
      extractionPolicyVersion: doc.extractionPolicyVersion,
      pdfCoverage: doc.pdfCoverage,
      corpusKey: doc.corpusKey,
      preserveVectors: true,
    });
  }
  const vectorProfiles = new Map<string, { fileId: string; corpusKey: string }>();
  for (const doc of validated.documents) {
    const corpusKey = doc.corpusKey || 'user';
    vectorProfiles.set(`${corpusKey}\u0000${doc.id}`, { fileId: doc.id, corpusKey });
  }
  for (const profile of vectorProfiles.values()) {
    await removeVectorsForFile(profile.fileId, profile.corpusKey);
  }
  const vectors = await restoreVectorRecordsFromBackup(validated.vectors);
  for (const file of validated.vaultFiles) await saveVaultFile(file);
  const driveSnapshots = await restoreDriveMetaSnapshotsFromBackup(validated.driveSnapshots);
  return {
    documents: validated.documents.length,
    vectors,
    vaultItems: validated.vaultFiles.length,
    driveSnapshots,
  };
}
