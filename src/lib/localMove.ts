/**
 * Safety-critical local duplicate move primitives.
 * A source may only be removed after the destination bytes are verified.
 */

export interface WritableFile {
  write(data: Blob | ArrayBuffer | string): Promise<void>;
  close(): Promise<void>;
}

export interface DestinationFileHandle {
  getFile(): Promise<Blob>;
  createWritable(): Promise<WritableFile>;
}

async function sha256Bytes(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Re-read and verify the source, copy it, then re-read and verify the copy.
 * The caller must remove the source only after this resolves successfully.
 */
export async function copyAndVerifyLocalFile(
  source: Blob,
  destination: DestinationFileHandle,
  expectedHash: string,
): Promise<void> {
  const sourceBytes = await source.arrayBuffer();
  const sourceHash = 'sha256:' + await sha256Bytes(sourceBytes);
  if (sourceHash !== expectedHash) {
    throw new Error('File changed after verification; move stopped safely');
  }

  const writable = await destination.createWritable();
  try {
    await writable.write(sourceBytes);
    await writable.close();
  } catch (error) {
    throw error;
  }

  const copied = await destination.getFile();
  const copiedHash = 'sha256:' + await sha256Bytes(await copied.arrayBuffer());
  if (copiedHash !== sourceHash) {
    throw new Error('Destination verification failed; source was retained');
  }
}
