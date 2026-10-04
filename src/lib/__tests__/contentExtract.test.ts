import { afterEach, describe, expect, it, vi } from 'vitest';
import { canExtractText, extractDriveFileText } from '../contentExtract';
import { MAX_INDEX_CHARS } from '../contentIndex';
import { extractPdfTextWithOcr, selectPdfOcrPages, shouldOcrPdfPage } from '../ocrExtract';

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

describe('PDF page sampling policy', () => {
  it('includes every page for PDFs of 10 pages or fewer', () => {
    expect(selectPdfOcrPages(1)).toEqual([1]);
    expect(selectPdfOcrPages(10)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(selectPdfOcrPages(10, 'expanded')).toHaveLength(10);
  });

  it('samples the first five and last five pages for longer PDFs', () => {
    expect(selectPdfOcrPages(11)).toEqual([1, 2, 3, 4, 5, 7, 8, 9, 10, 11]);
    const longSample = selectPdfOcrPages(600);
    expect(longSample).toHaveLength(10);
    expect(longSample.slice(0, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(longSample.slice(-5)).toEqual([596, 597, 598, 599, 600]);
  });

  it('adds no more than five evenly-spaced middle pages for an explicit expanded check', () => {
    const sample = selectPdfOcrPages(600, 'expanded');
    expect(sample).toHaveLength(15);
    expect(sample).toEqual([...sample].sort((a, b) => a - b));
    expect(sample.slice(0, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(sample.slice(-5)).toEqual([596, 597, 598, 599, 600]);
    expect(sample.filter(page => page > 5 && page < 596)).toHaveLength(5);
  });

  it('does not OCR pages that already have enough selectable text', () => {
    expect(shouldOcrPdfPage('')).toBe(true);
    expect(shouldOcrPdfPage('Only a short title')).toBe(true);
    expect(shouldOcrPdfPage('This page has enough selectable text to search without OCR at all.')).toBe(false);
  });

  it('extracts a long digital PDF only from the sampled pages, without loading Tesseract', async () => {
    const visited: number[] = [];
    const fakePdf = {
      numPages: 11,
      getPage: vi.fn(async (pageNo: number) => {
        visited.push(pageNo);
        return {
          getTextContent: async () => ({ items: [{ str: `This selectable digital page number ${pageNo} contains enough words to skip unnecessary OCR.` }] }),
          cleanup: vi.fn(),
        };
      }),
      cleanup: vi.fn(),
      destroy: vi.fn(),
    };
    vi.stubGlobal('window', {
      pdfjsLib: {
        GlobalWorkerOptions: {},
        getDocument: () => ({ promise: Promise.resolve(fakePdf) }),
      },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { status: 200 })));

    const result = await extractDriveFileText('token', 'pdf-id', 'application/pdf', 'book.pdf');
    expect(visited).toEqual([1, 2, 3, 4, 5, 7, 8, 9, 10, 11]);
    expect(result.text).toContain('[Page 1]');
    expect(result.text).toContain('[Page 11]');
    expect(result.text).not.toContain('[Page 6]');
    expect(result.pdfCoverage).toMatchObject({
      totalPages: 11,
      policy: 'first-last-5',
      deferredPageCount: 1,
      nativeTextPageCount: 10,
      attemptedOcrPages: [],
    });
  });

  it('OCRs only selected pages in a long scanned PDF and reuses one worker', async () => {
    const visited: number[] = [];
    const recognize = vi.fn(async () => ({ data: { text: 'recognized words from a scanned page' } }));
    const terminate = vi.fn(async () => undefined);
    const fakePdf = {
      numPages: 11,
      getPage: vi.fn(async (pageNo: number) => {
        visited.push(pageNo);
        return {
          getTextContent: async () => ({ items: [] }),
          getViewport: () => ({ width: 1200, height: 1600 }),
          render: () => ({ promise: Promise.resolve() }),
          cleanup: vi.fn(),
        };
      }),
      cleanup: vi.fn(),
      destroy: vi.fn(),
    };
    vi.stubGlobal('window', {
      pdfjsLib: {
        GlobalWorkerOptions: {},
        getDocument: () => ({ promise: Promise.resolve(fakePdf) }),
      },
      Tesseract: {
        createWorker: vi.fn(async () => ({ recognize, terminate })),
      },
    });
    vi.stubGlobal('document', {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({}),
        toBlob: (callback: (blob: Blob) => void) => callback(new Blob(['page image'])),
      }),
    });

    const result = await extractPdfTextWithOcr(new ArrayBuffer(8));
    expect(visited).toEqual([1, 2, 3, 4, 5, 7, 8, 9, 10, 11]);
    expect(recognize).toHaveBeenCalledTimes(10);
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(result.text).toContain('[Page 1]');
    expect(result.text).toContain('[Page 11]');
    expect(result.text).not.toContain('[Page 6]');
    expect(result.coverage).toMatchObject({
      policy: 'first-last-5',
      deferredPageCount: 1,
      attemptedOcrPages: [1, 2, 3, 4, 5, 7, 8, 9, 10, 11],
      successfulOcrPages: [1, 2, 3, 4, 5, 7, 8, 9, 10, 11],
    });
  });
});

describe('binary document and OCR support', () => {
  it('recognizes supported MIME types', () => {
    expect(canExtractText('application/pdf', 'report.pdf')).toBe(true);
    expect(canExtractText('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'report.docx')).toBe(true);
    expect(canExtractText('application/vnd.ms-word.document.macroEnabled.12', 'report.docm')).toBe(true);
    expect(canExtractText('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'report.xlsx')).toBe(true);
    expect(canExtractText('application/vnd.openxmlformats-officedocument.presentationml.presentation', 'deck.pptx')).toBe(true);
    expect(canExtractText('image/png', 'scan.png')).toBe(true);
    expect(canExtractText('image/jpeg', 'scan.jpg')).toBe(true);
  });

  it('recognizes supported extensions even when Drive MIME metadata is generic', () => {
    expect(canExtractText('application/octet-stream', 'report.pdf')).toBe(true);
    expect(canExtractText('application/octet-stream', 'report.docx')).toBe(true);
    expect(canExtractText('application/octet-stream', 'report.xlsx')).toBe(true);
    expect(canExtractText('application/octet-stream', 'deck.pptx')).toBe(true);
    expect(canExtractText('application/octet-stream', 'scan.png')).toBe(true);
    expect(canExtractText('application/octet-stream', 'scan.jpeg')).toBe(true);
  });

  it('does not mark unrelated binary files as text-extractable', () => {
    expect(canExtractText('application/octet-stream', 'photo.zip')).toBe(false);
    expect(canExtractText('application/zip', 'archive.zip')).toBe(false);
  });
});
