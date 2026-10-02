/**
 * Extract searchable text from Google Drive files.
 * PDF/DOCX/XLSX use local binary extraction; scanned PDFs and images fall back to local OCR.
 * Supports AbortSignal so Cancel / per-file timeout can stop long downloads and OCR.
 */

import { fetchWithBackoff } from './rateLimit';
import { MAX_INDEX_CHARS } from './contentIndex';
import { extractDocxText, extractPdfText, extractXlsxText } from './binaryOfficeExtract';
import { ocrImage, ocrPdf, OcrAbortedError } from './ocrExtract';

const TEXTISH = [
  'text/plain', 'text/csv', 'text/markdown', 'text/html',
  'application/json', 'application/xml', 'text/xml',
];
const BINARY_EXTENSIONS = /\.(pdf|docx|xlsx)$/i;
const IMAGE_EXTENSIONS = /\.(png|jpe?g|webp|bmp|gif|tiff?)$/i;
const BINARY_MIMES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);
const IMAGE_MIMES = new Set([
  'image/png', 'image/jpeg', 'image/webp', 'image/bmp', 'image/gif', 'image/tiff',
]);
const MAX_BINARY_BYTES = 50 * 1024 * 1024;
/** Soft ceiling for one file's download + extract + OCR (ms). */
export const EXTRACT_FILE_TIMEOUT_MS = 90_000;

export interface ExtractResult {
  text: string;
  source: 'export' | 'binary-text';
  truncated: boolean;
  note?: string;
}

export class ExtractAbortedError extends Error {
  constructor(message = 'Extraction aborted') {
    super(message);
    this.name = 'ExtractAbortedError';
  }
}

export function canExtractText(mimeType: string, name: string): boolean {
  const m = mimeType || '';
  if (m.startsWith('text/') || TEXTISH.includes(m)) return true;
  if (m === 'application/vnd.google-apps.document' || m === 'application/vnd.google-apps.spreadsheet' || m === 'application/vnd.google-apps.presentation') return true;
  if (BINARY_MIMES.has(m) || IMAGE_MIMES.has(m)) return true;
  if (/\.(txt|md|csv|json|xml|html|log)$/i.test(name || '')) return true;
  if (BINARY_EXTENSIONS.test(name || '') || IMAGE_EXTENSIONS.test(name || '')) return true;
  return false;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ExtractAbortedError();
}

async function readTextCapped(res: Response, maxChars: number = MAX_INDEX_CHARS, signal?: AbortSignal): Promise<{ text: string; truncated: boolean }> {
  throwIfAborted(signal);
  const reader = res.body?.getReader();
  if (!reader) {
    const text = await res.text();
    throwIfAborted(signal);
    return { text: text.slice(0, maxChars), truncated: text.length > maxChars };
  }
  const decoder = new TextDecoder();
  let text = '';
  let truncated = false;
  while (text.length < maxChars) {
    throwIfAborted(signal);
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    if (text.length >= maxChars) {
      text = text.slice(0, maxChars);
      truncated = true;
      try { await reader.cancel(); } catch { /* ignore */ }
      break;
    }
  }
  return { text, truncated };
}

async function driveFetch(url: string, accessToken: string, label: string, signal?: AbortSignal): Promise<Response> {
  throwIfAborted(signal);
  return fetchWithBackoff(
    url,
    { headers: { Authorization: 'Bearer ' + accessToken }, signal },
    { label, maxRetries: 5, baseMs: 600, timeoutMs: 45_000 }
  );
}

async function readBinaryCapped(res: Response, signal?: AbortSignal): Promise<{ buffer: ArrayBuffer; truncated: boolean }> {
  throwIfAborted(signal);
  const buffer = await res.arrayBuffer();
  throwIfAborted(signal);
  if (buffer.byteLength <= MAX_BINARY_BYTES) return { buffer, truncated: false };
  throw new Error(`Binary file exceeds ${MAX_BINARY_BYTES / (1024 * 1024)} MB extraction limit`);
}

export async function extractDriveFileText(
  accessToken: string,
  fileId: string,
  mimeType: string,
  name: string,
  signal?: AbortSignal
): Promise<ExtractResult> {
  throwIfAborted(signal);
  const m = mimeType || '';
  const extension = /\.([^.]+)$/i.exec(name || '')?.[1]?.toLowerCase() || '';

  if (m === 'application/vnd.google-apps.document') {
    const res = await driveFetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent('text/plain')}`, accessToken, 'doc-export', signal);
    if (!res.ok) throw new Error('Doc export failed: ' + res.status);
    return { ...(await readTextCapped(res, MAX_INDEX_CHARS, signal)), source: 'export' };
  }
  if (m === 'application/vnd.google-apps.spreadsheet') {
    const res = await driveFetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent('text/csv')}`, accessToken, 'sheet-export', signal);
    if (!res.ok) throw new Error('Sheet export failed: ' + res.status);
    return { ...(await readTextCapped(res, MAX_INDEX_CHARS, signal)), source: 'export' };
  }
  if (m === 'application/vnd.google-apps.presentation') {
    const res = await driveFetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent('text/plain')}`, accessToken, 'slides-export', signal);
    if (!res.ok) throw new Error('Slides export failed: ' + res.status);
    return { ...(await readTextCapped(res, MAX_INDEX_CHARS, signal)), source: 'export', note: 'Slides text export' };
  }

  if (BINARY_MIMES.has(m) || BINARY_EXTENSIONS.test(name || '') || IMAGE_MIMES.has(m) || IMAGE_EXTENSIONS.test(name || '')) {
    const res = await driveFetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`, accessToken, `${extension || 'binary'}-extract`, signal);
    if (!res.ok) throw new Error('Binary media download failed: ' + res.status);
    const { buffer, truncated } = await readBinaryCapped(res, signal);

    let text = '';
    try {
      if (m === 'application/pdf' || extension === 'pdf') {
        text = await extractPdfText(buffer);
        if (!text.trim()) {
          text = await ocrPdf(buffer, signal);
          if (text.trim()) return { text: text.slice(0, MAX_INDEX_CHARS), source: 'binary-text', truncated: text.length > MAX_INDEX_CHARS, note: 'Scanned/image-only PDF OCR' };
        }
      } else if (m.includes('wordprocessingml') || extension === 'docx') {
        text = await extractDocxText(buffer);
      } else if (m.includes('spreadsheetml') || extension === 'xlsx') {
        text = await extractXlsxText(buffer);
      } else if (IMAGE_MIMES.has(m) || IMAGE_EXTENSIONS.test(name || '')) {
        text = await ocrImage(buffer, signal);
        if (text.trim()) return { text: text.slice(0, MAX_INDEX_CHARS), source: 'binary-text', truncated: text.length > MAX_INDEX_CHARS, note: 'Image OCR' };
      }
    } catch (e) {
      if (e instanceof OcrAbortedError || (e instanceof Error && e.name === 'OcrAbortedError')) {
        throw new ExtractAbortedError(e.message);
      }
      throw e;
    }

    if (!text.trim()) {
      const note = extension === 'pdf' || m === 'application/pdf'
        ? 'PDF contains no extractable text and OCR found no text.'
        : 'No extractable text found in binary document.';
      return { text: '', source: 'binary-text', truncated, note };
    }
    return { text: text.slice(0, MAX_INDEX_CHARS), source: 'binary-text', truncated: truncated || text.length > MAX_INDEX_CHARS };
  }

  if (m.startsWith('text/') || TEXTISH.includes(m) || /\.(txt|md|csv|json|xml|html|log)$/i.test(name || '')) {
    const res = await driveFetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`, accessToken, 'binary-text', signal);
    if (!res.ok) throw new Error('Media download failed: ' + res.status);
    return { ...(await readTextCapped(res, MAX_INDEX_CHARS, signal)), source: 'binary-text' };
  }

  throw new Error('Unsupported mime for text extract: ' + m);
}

export async function extractDriveFileTextWithTimeout(
  accessToken: string,
  fileId: string,
  mimeType: string,
  name: string,
  opts?: { signal?: AbortSignal; timeoutMs?: number }
): Promise<ExtractResult> {
  const timeoutMs = opts?.timeoutMs ?? EXTRACT_FILE_TIMEOUT_MS;
  const parent = opts?.signal;
  const controller = new AbortController();
  const onParentAbort = () => controller.abort();
  if (parent) {
    if (parent.aborted) throw new ExtractAbortedError();
    parent.addEventListener('abort', onParentAbort, { once: true });
  }
  const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await extractDriveFileText(accessToken, fileId, mimeType, name, controller.signal);
  } catch (e) {
    if (controller.signal.aborted && !(parent && parent.aborted)) {
      throw new ExtractAbortedError(`Extraction timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw e;
  } finally {
    globalThis.clearTimeout(timer);
    parent?.removeEventListener('abort', onParentAbort);
  }
}
