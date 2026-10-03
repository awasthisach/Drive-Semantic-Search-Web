import { describe, it, expect } from 'vitest';
import * as contentIndex from '../contentIndex';
import {
  buildEmbeddingChunks, chunkText, tokenize, searchContentIndex,
  putIndexedDocument, getIndexedDocument, countIndexedDocuments, removeIndexedDocumentsByIds,
  isLegacyTitleEmbeddingChunk,
} from '../contentIndex';

describe('chunkText', () => {
  it('returns empty for blank', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   ')).toEqual([]);
  });

  it('returns single chunk for short text', () => {
    const c = chunkText('hello world');
    expect(c.length).toBe(1);
    expect(c[0]).toContain('hello');
  });

  it('splits long text into multiple chunks', () => {
    const long = 'word '.repeat(500);
    const c = chunkText(long);
    expect(c.length).toBeGreaterThan(1);
  });
});

describe('tokenize', () => {
  it('lowercases and splits', () => {
    expect(tokenize('Hello WORLD test')).toEqual(['hello', 'world', 'test']);
  });

  it('drops short tokens', () => {
    expect(tokenize('a bb ccc')).toEqual(['bb', 'ccc']);
  });
});

describe('buildEmbeddingChunks', () => {
  it('keeps filenames out so renamed copies have the same semantic content profile', () => {
    const originalName = buildEmbeddingChunks('Hemp Research.pdf', 'A short body');
    const renamedCopy = buildEmbeddingChunks('Different archive title.pdf', 'A short body');
    expect(originalName).toEqual(['A short body']);
    expect(renamedCopy).toEqual(originalName);
    expect(isLegacyTitleEmbeddingChunk('title: Hemp Research.pdf | text: A short body')).toBe(true);
    expect(isLegacyTitleEmbeddingChunk('A short body')).toBe(false);
  });
});

describe('legacy removal guard', () => {
  it('does not export getAllChunks', () => {
    const mod = contentIndex as unknown as Record<string, unknown>;
    expect(mod.getAllChunks).toBeUndefined();
  });

  it('does not export searchContentIndexLegacy', () => {
    const mod = contentIndex as unknown as Record<string, unknown>;
    expect(mod.searchContentIndexLegacy).toBeUndefined();
  });

  it('returns empty map when no postings are available', async () => {
    const res = await searchContentIndex('alpha beta gamma');
    expect(res.size).toBe(0);
  });
});

describe('durable content index mutations', () => {
  it('replaces documents and postings without retaining stale terms', async () => {
    await putIndexedDocument({ id: 'replace-test', name: 'Old', mimeType: 'text/plain', text: 'alpha oldtoken', source: 'binary-text', corpusKey: 'test' });
    await putIndexedDocument({ id: 'replace-test', name: 'New', mimeType: 'text/plain', text: 'bravo newtoken', source: 'binary-text', corpusKey: 'test' });

    expect((await getIndexedDocument('replace-test'))?.name).toBe('New');
    expect(await countIndexedDocuments('test')).toBe(1);
    expect((await searchContentIndex('oldtoken', 'test')).has('replace-test')).toBe(false);
    expect((await searchContentIndex('newtoken', 'test')).has('replace-test')).toBe(true);

    expect(await removeIndexedDocumentsByIds(['replace-test'])).toBe(1);
    expect(await getIndexedDocument('replace-test')).toBeNull();
    expect((await searchContentIndex('newtoken', 'test')).has('replace-test')).toBe(false);
  });

  it('persists sampled-PDF coverage and marks old extraction policies stale', async () => {
    const pdfCoverage = {
      totalPages: 80,
      policy: 'first-last-5' as const,
      sampledPages: [1, 2, 3, 4, 5, 76, 77, 78, 79, 80],
      attemptedOcrPages: [1, 2, 3, 4, 5, 76, 77, 78, 79, 80],
      successfulOcrPages: [1, 2, 3, 4, 5, 76, 77, 78, 79, 80],
      deferredPageCount: 70,
      nativeTextPageCount: 0,
    };
    const policy = 'pdf-page-sampled-v1';
    await putIndexedDocument({
      id: 'sampled-pdf',
      name: 'book.pdf',
      mimeType: 'application/pdf',
      text: 'sampled OCR content',
      source: 'binary-text',
      driveModifiedTime: '2024-01-01T00:00:00.000Z',
      extractionPolicyVersion: policy,
      pdfCoverage,
      corpusKey: 'test',
    });

    const stored = await getIndexedDocument('sampled-pdf');
    expect(stored?.pdfCoverage).toEqual(pdfCoverage);
    expect(contentIndex.isDocumentStale(stored, '2024-01-01T00:00:00.000Z', policy)).toBe(false);
    expect(contentIndex.isDocumentStale(stored, '2024-01-01T00:00:00.000Z', 'new-policy')).toBe(true);
  });
});
