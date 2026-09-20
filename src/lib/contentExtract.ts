/**
 * Extract searchable text from Google Drive files (export or binary text).
 */

import { fetchWithBackoff } from './rateLimit';
import { MAX_INDEX_CHARS } from './contentIndex';

const TEXTISH = [
  'text/plain',
  'text/csv',
  'text/markdown',
  'text/html',
  'application/json',
  'application/xml',
  'text/xml',
];

export interface ExtractResult {
  text: string;
  source: 'export' | 'binary-text';
  note?: string;
}

export function canExtractText(mimeType: string, name: string): boolean {
  const m = mimeType || '';
  if (m.startsWith('text/')) return true;
  if (TEXTISH.includes(m)) return true;
  if (m === 'application/vnd.google-apps.document') return true;
  if (m === 'application/vnd.google-apps.spreadsheet') return true;
  if (m === 'application/vnd.google-apps.presentation') return true;
  if (/\.(txt|md|csv|json|xml|html|log)$/i.test(name || '')) return true;
  return false;
}

/** Read response body but stop after maxChars to limit JS heap pressure. */
async function readTextCapped(res: Response, maxChars: number = MAX_INDEX_CHARS): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) {
    const t = await res.text();
    return t.slice(0, maxChars);
  }
  const decoder = new TextDecoder();
  let out = '';
  while (out.length < maxChars) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
    if (out.length >= maxChars) {
      out = out.slice(0, maxChars);
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
      break;
    }
  }
  return out;
}

async function driveFetch(
  url: string,
  accessToken: string,
  label: string
): Promise<Response> {
  return fetchWithBackoff(
    url,
    { headers: { Authorization: 'Bearer ' + accessToken } },
    { label, maxRetries: 5, baseMs: 600 }
  );
}

export async function extractDriveFileText(
  accessToken: string,
  fileId: string,
  mimeType: string,
  name: string
): Promise<ExtractResult> {
  const m = mimeType || '';

  if (m === 'application/vnd.google-apps.document') {
    const res = await driveFetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=${encodeURIComponent('text/plain')}`,
      accessToken,
      'doc-export'
    );
    if (!res.ok) throw new Error('Doc export failed: ' + res.status);
    return { text: await readTextCapped(res), source: 'export' };
  }

  if (m === 'application/vnd.google-apps.spreadsheet') {
    const res = await driveFetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=${encodeURIComponent('text/csv')}`,
      accessToken,
      'sheet-export'
    );
    if (!res.ok) throw new Error('Sheet export failed: ' + res.status);
    return { text: await readTextCapped(res), source: 'export' };
  }

  if (m === 'application/vnd.google-apps.presentation') {
    const res = await driveFetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=${encodeURIComponent('text/plain')}`,
      accessToken,
      'slides-export'
    );
    if (!res.ok) throw new Error('Slides export failed: ' + res.status);
    return { text: await readTextCapped(res), source: 'export', note: 'Slides text export' };
  }

  if (m.startsWith('text/') || TEXTISH.includes(m) || /\.(txt|md|csv|json|xml|html|log)$/i.test(name || '')) {
    const res = await driveFetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`,
      accessToken,
      'binary-text'
    );
    if (!res.ok) throw new Error('Media download failed: ' + res.status);
    return { text: await readTextCapped(res), source: 'binary-text' };
  }

  throw new Error('Unsupported mime for text extract: ' + m);
}
