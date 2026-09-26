import { describe, it, expect } from 'vitest';
import * as contentIndex from '../contentIndex';
import {
  buildEmbeddingChunks, chunkText, tokenize, searchContentIndex,
  putIndexedDocument, getIndexedDocument, countIndexedDocuments, removeIndexedDocumentsByIds,
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
  it('includes the filename in every embedding chunk', () => {
    const chunks = buildEmbeddingChunks('Hemp Research.pdf', 'A short body');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe('title: Hemp Research.pdf | text: A short body');
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
});
