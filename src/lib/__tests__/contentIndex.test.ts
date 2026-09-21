import { describe, it, expect } from 'vitest';
import * as contentIndex from '../contentIndex';
import { chunkText, tokenize, searchContentIndex } from '../contentIndex';

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
