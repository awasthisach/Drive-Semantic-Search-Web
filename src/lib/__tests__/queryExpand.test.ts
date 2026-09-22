import { describe, it, expect } from 'vitest';
import { expandTerms } from '../queryExpand';

describe('expandTerms', () => {
  it('expands bhang to भांग', () => {
    const t = expandTerms('bhang report');
    expect(t).toContain('bhang');
    expect(t).toContain('भांग');
  });
  it('expands भांग to bhang', () => {
    const t = expandTerms('भांग');
    expect(t).toContain('भांग');
    expect(t).toContain('bhang');
  });
  it('ignores short tokens', () => {
    expect(expandTerms('a x')).toEqual([]);
  });
});
