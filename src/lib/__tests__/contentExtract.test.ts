import { afterEach, describe, expect, it, vi } from 'vitest';
import { canExtractText, extractDriveFileText } from '../contentExtract';
import { MAX_INDEX_CHARS } from '../contentIndex';

afterEach(() => vi.unstubAllGlobals());

describe('extractDriveFileText truncation metadata', () => {
  it('marks a response truncated when the streaming character cap is reached', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('x'.repeat(MAX_INDEX_CHARS + 10), { status: 200 })));
    const result = await extractDriveFileText('token', 'file-id', 'text/plain', 'long.txt');
    expect(result.text).toHaveLength(MAX_INDEX_CHARS);
    expect(result.truncated).toBe(true);
  });

  it('does not mark a short response truncated', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('short text', { status: 200 })));
    const result = await extractDriveFileText('token', 'file-id', 'text/plain', 'short.txt');
    expect(result).toMatchObject({ text: 'short text', source: 'binary-text', truncated: false });
  });
});

describe('binary document extraction support', () => {
  it('recognizes supported MIME types', () => {
    expect(canExtractText('application/pdf', 'report.pdf')).toBe(true);
    expect(canExtractText('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'report.docx')).toBe(true);
    expect(canExtractText('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'report.xlsx')).toBe(true);
  });

  it('recognizes supported extensions even when Drive MIME metadata is generic', () => {
    expect(canExtractText('application/octet-stream', 'report.pdf')).toBe(true);
    expect(canExtractText('application/octet-stream', 'report.docx')).toBe(true);
    expect(canExtractText('application/octet-stream', 'report.xlsx')).toBe(true);
  });

  it('does not mark unrelated binary files as text-extractable', () => {
    expect(canExtractText('application/octet-stream', 'photo.jpg')).toBe(false);
    expect(canExtractText('application/zip', 'archive.zip')).toBe(false);
  });
});
