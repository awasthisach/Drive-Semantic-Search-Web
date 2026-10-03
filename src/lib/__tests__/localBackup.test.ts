// @vitest-environment node
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { putIndexedDocument, listIndexedDocuments } from '../contentIndex';
import { listVectors, restoreVectorRecordsFromBackup } from '../vectorIndex';
import { saveVaultFile, loadVaultFiles } from '../vaultStore';
import { restoreDriveMetaSnapshotsFromBackup, loadDriveMetaSnapshot } from '../driveMetaStore';
import { createLocalBackupBlob, inspectLocalBackup, restoreLocalBackup } from '../localBackup';
import type { DriveFile, VaultFile } from '../../types';
import type { VectorRecord } from '../vectorIndex';

const driveFile: DriveFile = {
  id: 'drive-file-1',
  name: 'Notes.pdf',
  mimeType: 'application/pdf',
  size: 128,
  modifiedTime: '2026-10-01T00:00:00.000Z',
  createdTime: '2026-09-01T00:00:00.000Z',
  category: 'document',
  isGoogleDriveItem: true,
  isOffline: false,
  isEncrypted: false,
  contentHash: 'gdrive-drive-file-1-128',
  tags: [],
  semanticSummary: '',
};

const vaultItem: VaultFile = {
  id: 'vault-test-1',
  name: 'Private note.aes',
  originalName: 'Private note',
  size: 12,
  mimeType: 'text/plain',
  encryptedData: 'Y2lwaGVydGV4dA==',
  iv: 'aXY=',
  salt: 'c2FsdA==',
  uploadedAt: '2026-10-01T00:00:00.000Z',
  tags: ['test'],
};

const vector: VectorRecord = {
  id: 'user::drive-file-1#0',
  fileId: 'drive-file-1',
  idx: 0,
  text: 'safe sample body text',
  embedding: [1],
  corpusKey: 'user',
  contentHash: 'content-hash',
  embeddingModel: 'test-model',
  embeddingVersion: 'v1',
  dimension: 1,
  indexedAt: '2026-10-01T00:00:00.000Z',
};

describe('local encrypted backup', () => {
  it('encrypts, validates, and restores a mergeable local snapshot', async () => {
    await putIndexedDocument({
      id: driveFile.id,
      name: driveFile.name,
      mimeType: driveFile.mimeType,
      text: 'confidential extracted text that must stay encrypted in the archive',
      source: 'binary-text',
      driveModifiedTime: driveFile.modifiedTime,
      corpusKey: 'user',
      preserveVectors: true,
    });
    await restoreVectorRecordsFromBackup([vector]);
    await saveVaultFile(vaultItem);
    await restoreDriveMetaSnapshotsFromBackup([{
      key: 'user',
      files: [driveFile],
      folders: [],
      corpus: 'user',
      savedAt: '2026-10-01T00:00:00.000Z',
    }]);

    const backup = await createLocalBackupBlob('a sufficiently long backup phrase');
    expect(backup.size).toBeGreaterThan(64);
    const archiveBytes = new Uint8Array(await backup.arrayBuffer());
    const archiveText = new TextDecoder().decode(archiveBytes);
    expect(archiveText).not.toContain('confidential extracted text');
    expect(archiveText).not.toContain('Private note');

    const payload = await inspectLocalBackup(backup, 'a sufficiently long backup phrase');
    expect(payload.documents).toHaveLength(1);
    expect(payload.vectors).toHaveLength(1);
    expect(payload.vaultFiles).toHaveLength(1);
    expect(payload.driveSnapshots).toHaveLength(1);
    await expect(inspectLocalBackup(backup, 'incorrect phrase')).rejects.toThrow(/decrypt/i);

    const restored = await restoreLocalBackup(payload);
    expect(restored).toEqual({ documents: 1, vectors: 1, vaultItems: 1, driveSnapshots: 1 });
    expect((await listIndexedDocuments()).find(item => item.id === driveFile.id)?.text)
      .toContain('confidential extracted text');
    expect((await listVectors()).find(item => item.id === vector.id)?.embedding).toEqual([1]);
    expect((await loadVaultFiles()).find(item => item.id === vaultItem.id)?.encryptedData)
      .toBe(vaultItem.encryptedData);
    expect((await loadDriveMetaSnapshot('user'))?.files[0]?.id).toBe(driveFile.id);
  });

  it('rejects export passphrases shorter than 12 characters', async () => {
    await expect(createLocalBackupBlob('too short')).rejects.toThrow(/12 characters/i);
  });
});
