import { describe, expect, it } from 'vitest';
import { copyAndVerifyLocalFile } from '../localMove';

function makeDestination(opts?: { corrupt?: boolean }) {
  let stored = new Blob();
  return {
    getFile: async () => opts?.corrupt ? new Blob(['corrupted']) : stored,
    createWritable: async () => ({
      write: async (data: Blob | ArrayBuffer | string) => {
        stored = new Blob([data]);
      },
      close: async () => {},
    }),
  };
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return 'sha256:' + Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

describe('copyAndVerifyLocalFile', () => {
  it('copies only when the destination has the same SHA-256 as the source', async () => {
    const destination = makeDestination();
    await expect(copyAndVerifyLocalFile(new Blob(['duplicate bytes']), destination, await sha256('duplicate bytes'))).resolves.toBeUndefined();
  });

  it('retains the source when the source changed after duplicate discovery', async () => {
    const destination = makeDestination();
    await expect(copyAndVerifyLocalFile(new Blob(['changed bytes']), destination, await sha256('original bytes')))
      .rejects.toThrow(/changed after verification/i);
  });

  it('retains the source when the copied destination fails final hash verification', async () => {
    const destination = makeDestination({ corrupt: true });
    await expect(copyAndVerifyLocalFile(new Blob(['duplicate bytes']), destination, await sha256('duplicate bytes')))
      .rejects.toThrow(/destination verification failed/i);
  });
});
