/**
 * Client-side vault crypto
 * PBKDF2-SHA-256 (310,000 iterations) -> AES-GCM-256
 * Prefer Web Worker (cryptoWorker.ts); fall back to main thread.
 */

function bufToBase64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToBuf(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const PBKDF2_ITERATIONS = 310000;

export async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt as BufferSource,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function encryptData(
  plainText: string,
  passphrase: string
): Promise<{ ciphertext: string; iv: string; salt: string }> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const enc = new TextEncoder();
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    enc.encode(plainText)
  );
  return {
    ciphertext: bufToBase64(ciphertext),
    iv: bufToBase64(iv),
    salt: bufToBase64(salt),
  };
}

export async function decryptData(
  ciphertext: string,
  iv: string,
  salt: string,
  passphrase: string
): Promise<string> {
  const key = await deriveKey(passphrase, base64ToBuf(salt));
  const plainBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBuf(iv) as BufferSource },
    key,
    base64ToBuf(ciphertext) as BufferSource
  );
  return new TextDecoder().decode(plainBuf);
}

type WorkerResult = { ciphertext: string; iv: string; salt: string };

let workerInstance: Worker | null = null;
let workerBroken = false;
let msgId = 0;

function getCryptoWorker(): Worker | null {
  if (workerBroken || typeof Worker === 'undefined') return null;
  if (workerInstance) return workerInstance;
  try {
    workerInstance = new Worker(new URL('./cryptoWorker.ts', import.meta.url), {
      type: 'module',
    });
    workerInstance.onerror = () => {
      workerBroken = true;
      workerInstance = null;
    };
    return workerInstance;
  } catch {
    workerBroken = true;
    return null;
  }
}

function workerCall<T>(type: 'encrypt' | 'decrypt', payload: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    const worker = getCryptoWorker();
    if (!worker) {
      reject(new Error('Worker unavailable'));
      return;
    }
    // Capture non-null Worker for nested callbacks (strictNullChecks)
    const w: Worker = worker;
    const id = 'c' + ++msgId;
    const timer = setTimeout(() => {
      w.removeEventListener('message', onMsg);
      reject(new Error('Worker timeout'));
    }, 60000);

    function onMsg(e: MessageEvent) {
      if (!e.data || e.data.id !== id) return;
      clearTimeout(timer);
      w.removeEventListener('message', onMsg);
      if (e.data.success) resolve(e.data.result as T);
      else reject(new Error(e.data.error || 'Worker crypto failed'));
    }

    w.addEventListener('message', onMsg);
    w.postMessage({ id, type, payload });
  });
}

/** Encrypt via Worker when available; otherwise main-thread Web Crypto. */
export async function encryptDataWithWorker(
  plainText: string,
  passphrase: string
): Promise<{ ciphertext: string; iv: string; salt: string }> {
  try {
    return await workerCall<WorkerResult>('encrypt', { plainText, passphrase });
  } catch {
    return encryptData(plainText, passphrase);
  }
}

/** Decrypt via Worker when available; otherwise main-thread Web Crypto. */
export async function decryptDataWithWorker(
  ciphertext: string,
  iv: string,
  salt: string,
  passphrase: string
): Promise<string> {
  try {
    return await workerCall<string>('decrypt', { ciphertext, iv, salt, passphrase });
  } catch {
    return decryptData(ciphertext, iv, salt, passphrase);
  }
}
