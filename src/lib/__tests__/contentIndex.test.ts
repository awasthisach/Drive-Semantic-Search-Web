import { describe, it, expect } from 'vitest';
import { chunkText } from '../contentIndex';

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
