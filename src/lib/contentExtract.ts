/**
 * Extract searchable text from Google Drive files (export or binary text).
 */

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

export async function extractDriveFileText(
  accessToken: string,
  fileId: string,
  mimeType: string,
  name: string
): Promise<ExtractResult> {
  const m = mimeType || '';

  if (m === 'application/vnd.google-apps.document') {
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=${encodeURIComponent('text/plain')}`,
      { headers: { Authorization: 'Bearer ' + accessToken } }
    );
    if (!res.ok) throw new Error('Doc export failed: ' + res.status);
    return { text: await res.text(), source: 'export' };
  }

  if (m === 'application/vnd.google-apps.spreadsheet') {
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=${encodeURIComponent('text/csv')}`,
      { headers: { Authorization: 'Bearer ' + accessToken } }
    );
    if (!res.ok) throw new Error('Sheet export failed: ' + res.status);
    return { text: await res.text(), source: 'export' };
  }

  if (m === 'application/vnd.google-apps.presentation') {
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=${encodeURIComponent('text/plain')}`,
      { headers: { Authorization: 'Bearer ' + accessToken } }
    );
    if (!res.ok) throw new Error('Slides export failed: ' + res.status);
    return { text: await res.text(), source: 'export', note: 'Slides text export' };
  }

  if (m.startsWith('text/') || TEXTISH.includes(m) || /\.(txt|md|csv|json|xml|html|log)$/i.test(name || '')) {
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`,
      { headers: { Authorization: 'Bearer ' + accessToken } }
    );
    if (!res.ok) throw new Error('Download failed: ' + res.status);
    const text = await res.text();
    return { text, source: 'binary-text' };
  }

  throw new Error('No text extractor for mime: ' + m);
}
