/**
 * Drive content hashing: download/export bytes → SHA-256.
 * Sequential queue with soft rate limit.
 */

import { downloadDriveFileBytes, sha256Blob } from './offlineCache';
import type { DriveFile } from '../types';

export type HashProgress = {
  done: number;
  total: number;
  currentName?: string;
  lastError?: string;
};

export async function hashDriveFile(
  accessToken: string,
  file: DriveFile
): Promise<{ sha256: string; size: number }> {
  const { blob } = await downloadDriveFileBytes(accessToken, file.id, file.mimeType);
  const sha = await sha256Blob(blob);
  return { sha256: sha, size: blob.size };
}

export async function verifyFilesHashQueue(
  accessToken: string,
  files: DriveFile[],
  opts: {
    onProgress?: (p: HashProgress) => void;
    onHashed?: (fileId: string, contentHash: string, size: number) => void;
    shouldCancel?: () => boolean;
  } = {}
): Promise<{ ok: number; failed: number }> {
  const list = files.filter(f => f.isGoogleDriveItem);
  let ok = 0;
  let failed = 0;
  let done = 0;

  for (const file of list) {
    if (opts.shouldCancel?.()) break;
    opts.onProgress?.({ done, total: list.length, currentName: file.name });
    try {
      const { sha256, size } = await hashDriveFile(accessToken, file);
      opts.onHashed?.(file.id, 'sha256:' + sha256, size);
      ok++;
    } catch (e: any) {
      failed++;
      opts.onProgress?.({
        done,
        total: list.length,
        currentName: file.name,
        lastError: e?.message || 'hash failed',
      });
    }
    done++;
    opts.onProgress?.({ done, total: list.length, currentName: file.name });
    await new Promise(r => setTimeout(r, 120));
  }

  return { ok, failed };
}
