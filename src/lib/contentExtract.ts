/**
 * Extract searchable text from Google Drive files.
 * PDF text is extracted page-by-page with PDF.js; Tesseract runs only for sparse
 * text-layer pages selected by the bounded OCR policy. Other supported binary
 * formats and Google-native exports remain browser-local.
 */

import { fetchWithBackoff } from './rateLimit';
import { MAX_INDEX_CHARS } from './contentIndex';
import { extractDocxText, extractXlsxText } from './binaryOfficeExtract';
import {
  extractPdfTextWithOcr,
  ocrImage,
  OcrAbortedError,
  PDF_EXTRACTION_POLICY_VERSION,
  type PdfOcrCoverage,
  type PdfOcrMode,
} from './ocrExtract';

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
  pdfCoverage?: PdfOcrCoverage;
  extractionPolicyVersion?: string;
}

export interface ExtractOptions {
  /** 'expanded' adds up to five evenly-spaced middle pages for a deliberate deep check. */
  pdfOcrMode?: PdfOcrMode;
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
  signal?: AbortSignal,
  options?: ExtractOptions
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

    try {
      if (m === 'application/pdf' || extension === 'pdf') {
        const extracted = await extractPdfTextWithOcr(buffer, {
          signal,
          mode: options?.pdfOcrMode ?? 'sample',
        });
        const text = extracted.text;
        return {
          text: text.slice(0, MAX_INDEX_CHARS),
          source: 'binary-text',
          truncated: text.length > MAX_INDEX_CHARS,
          note: extracted.coverage.deferredPageCount
            ? `PDF semantic profile uses ${extracted.coverage.sampledPages.length}/${extracted.coverage.totalPages} sampled page(s); OCR is used only when sampled pages lack enough selectable text.`
            : 'PDF semantic profile includes every page; OCR is used only when a page lacks enough selectable text.',
          pdfCoverage: extracted.coverage,
          extractionPolicyVersion: PDF_EXTRACTION_POLICY_VERSION,
        };
      }
      if (m.includes('wordprocessingml') || extension === 'docx') {
        const text = await extractDocxText(buffer);
        return { text: text.slice(0, MAX_INDEX_CHARS), source: 'binary-text', truncated: truncated || text.length > MAX_INDEX_CHARS };
      }
      if (m.includes('spreadsheetml') || extension === 'xlsx') {
        const text = await extractXlsxText(buffer);
        return { text: text.slice(0, MAX_INDEX_CHARS), source: 'binary-text', truncated: truncated || text.length > MAX_INDEX_CHARS };
      }
      if (IMAGE_MIMES.has(m) || IMAGE_EXTENSIONS.test(name || '')) {
        const text = await ocrImage(buffer, signal);
        return { text: text.slice(0, MAX_INDEX_CHARS), source: 'binary-text', truncated: truncated || text.length > MAX_INDEX_CHARS, note: 'Image OCR' };
      }
    } catch (error) {
      if (error instanceof OcrAbortedError || (error instanceof Error && error.name === 'OcrAbortedError')) {
        throw new ExtractAbortedError(error.message);
      }
      throw error;
    }

    return { text: '', source: 'binary-text', truncated, note: 'No extractable text found in binary document.' };
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
  opts?: { signal?: AbortSignal; timeoutMs?: number; pdfOcrMode?: PdfOcrMode }
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
    return await extractDriveFileText(accessToken, fileId, mimeType, name, controller.signal, { pdfOcrMode: opts?.pdfOcrMode });
  } catch (error) {
    if (controller.signal.aborted && !(parent && parent.aborted)) {
      throw new ExtractAbortedError(`Extraction timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw error;
  } finally {
    globalThis.clearTimeout(timer);
    parent?.removeEventListener('abort', onParentAbort);
  }
}
