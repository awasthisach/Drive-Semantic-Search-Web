import { describe, it, expect } from 'vitest';
import { highlightSegments } from '../searchHighlight';

describe('highlightSegments', () => {
  it('marks matching terms', () => {
    const segs = highlightSegments('Annual report 2025', 'report annual');
    expect(segs.filter(s => s.match).map(s => s.text.toLowerCase())).toEqual(['annual', 'report']);
  });

  it('returns plain segment for empty query', () => {
    expect(highlightSegments('Hello world', '')).toEqual([{ text: 'Hello world', match: false }]);
  });

  it('returns empty array for empty text', () => {
    expect(highlightSegments('', 'report')).toEqual([]);
  });
});
