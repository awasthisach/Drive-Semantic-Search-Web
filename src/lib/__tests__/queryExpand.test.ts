import { describe, it, expect } from 'vitest';
import { expandSemanticQueries, expandTerms } from '../queryExpand';

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

  it('creates bounded cannabis semantic variants', () => {
    const variants = expandSemanticQueries('cannabis report');
    expect(variants).toContain('cannabis report');
    expect(variants).toContain('hemp report');
    expect(variants).toContain('भांग report');
    expect(variants.length).toBeLessThanOrEqual(3);
  });
});