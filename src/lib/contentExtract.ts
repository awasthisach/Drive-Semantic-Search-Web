/**
 * Extract searchable text from Google Drive files (export or binary text).
 */

import { fetchWithBackoff } from './rateLimit';
import { MAX_INDEX_CHARS } from './contentIndex';
import { extractDocxText, extractPdfText, extractXlsxText } from './binaryOfficeExtract';

const TEXTISH = [
  'text/plain',
  'text/csv',
  'text/markdown',
  'text/html',
  'application/json',
  'application/xml',
  'text/xml',
];

const BINARY_EXTENSIONS = /\.(pdf|docx|xlsx)$/i;
const BINARY_MIMES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

export interface ExtractResult {
  text: string;
  source: 'export' | 'binary-text';
  truncated: boolean;
  note?: string;
}

export function canExtractText(mimeType: string, name: string): boolean {
  const m = mimeType || '';
  if (m.startsWith('text/')) return true;
  if (TEXTISH.includes(m)) return true;
  if (m === 'application/vnd.google-apps.document') return true;
  if (m === 'application/vnd.google-apps.spreadsheet') return true;
  if (m === 'application/vnd.google-apps.presentation') return true;
  if (BINARY_MIMES.has(m)) return true;
  if (/\.(txt|md|csv|json|xml|html|log)$/i.test(name || '')) return true;
  if (BINARY_EXTENSIONS.test(name || '')) return true;
  return false;
}

/** Read response body but stop after maxChars to limit JS heap pressure. */
async function readTextCapped(
  res: Response,
  maxChars: number = MAX_INDEX_CHARS
): Promise<{ text: string; truncated: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) {
    const text = await res.text();
    return { text: text.slice(0, maxChars), truncated: text.length > maxChars };
  }
  const decoder = new TextDecoder();
  let text = '';
  let truncated = false;
  while (text.length < maxChars) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    if (text.length >= maxChars) {
      text = text.slice(0, maxChars);
      truncated = true;
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
      break;
    }
  }
  return { text, truncated };
}

async function driveFetch(url: string, accessToken: string, label: string): Promise<Response> {
  return fetchWithBackoff(
    url,
    { headers: { Authorization: 'Bearer ' + accessToken } },
    { label, maxRetries: 5, baseMs: 600, timeoutMs: 45_000 }
  );
}

async function readBinaryCapped(res: Response): Promise<{ buffer: ArrayBuffer; truncated: boolean }> {
  const buffer = await res.arrayBuffer();
  if (buffer.byteLength <= MAX_INDEX_CHARS * 4) return { buffer, truncated: false };
  return { buffer: buffer.slice(0, MAX_INDEX_CHARS * 4), truncated: true };
}

export async function extractDriveFileText(
  accessToken: string,
  fileId: string,
  mimeType: string,
  name: string
): Promise<ExtractResult> {
  const m = mimeType || '';
  const extension = /\.([^.]+)$/i.exec(name || '')?.[1]?.toLowerCase() || '';

  if (m === 'application/vnd.google-apps.document') {
    const res = await driveFetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent('text/plain')}`,
      accessToken,
      'doc-export'
    );
    if (!res.ok) throw new Error('Doc export failed: ' + res.status);
    return { ...(await readTextCapped(res)), source: 'export' };
  }

  if (m === 'application/vnd.google-apps.spreadsheet') {
    const res = await driveFetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent('text/csv')}`,
      accessToken,
      'sheet-export'
    );
    if (!res.ok) throw new Error('Sheet export failed: ' + res.status);
    return { ...(await readTextCapped(res)), source: 'export' };
  }

  if (m === 'application/vnd.google-apps.presentation') {
    const res = await driveFetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent('text/plain')}`,
      accessToken,
      'slides-export'
    );
    if (!res.ok) throw new Error('Slides export failed: ' + res.status);
    return { ...(await readTextCapped(res)), source: 'export', note: 'Slides text export' };
  }

  if (BINARY_MIMES.has(m) || BINARY_EXTENSIONS.test(name || '')) {
    const res = await driveFetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`,
      accessToken,
      `${extension || 'binary'}-extract`
    );
    if (!res.ok) throw new Error('Binary media download failed: ' + res.status);
    const { buffer, truncated } = await readBinaryCapped(res);
    let text = '';
    if (m === 'application/pdf' || extension === 'pdf') text = await extractPdfText(buffer);
    else if (m.includes('wordprocessingml') || extension === 'docx') text = await extractDocxText(buffer);
    else if (m.includes('spreadsheetml') || extension === 'xlsx') text = await extractXlsxText(buffer);
    if (!text.trim()) {
      const note = extension === 'pdf' || m === 'application/pdf'
        ? 'PDF contains no extractable text; scanned/image-only PDF may require OCR.'
        : 'No extractable text found in binary document.';
      return { text: '', source: 'binary-text', truncated, note };
    }
    return { text: text.slice(0, MAX_INDEX_CHARS), source: 'binary-text', truncated: truncated || text.length > MAX_INDEX_CHARS };
  }

  if (m.startsWith('text/') || TEXTISH.includes(m) || /\.(txt|md|csv|json|xml|html|log)$/i.test(name || '')) {
    const res = await driveFetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`,
      accessToken,
      'binary-text'
    );
    if (!res.ok) throw new Error('Media download failed: ' + res.status);
    return { ...(await readTextCapped(res)), source: 'binary-text' };
  }

  throw new Error('Unsupported mime for text extract: ' + m);
}
