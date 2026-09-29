import { describe, expect, it } from 'vitest';
import { paginateResults, SEARCH_RESULTS_PAGE_SIZE } from '../pagination';

describe('paginateResults', () => {
  it('limits the default page to 50 items and reports the range', () => {
    const items = Array.from({ length: 1875 }, (_, index) => index + 1);
    const page = paginateResults(items);

    expect(page.items).toHaveLength(SEARCH_RESULTS_PAGE_SIZE);
    expect(page.items[0]).toBe(1);
    expect(page.items.at(-1)).toBe(50);
    expect(page.page).toBe(1);
    expect(page.pageCount).toBe(38);
    expect(page.start).toBe(1);
    expect(page.end).toBe(50);
    expect(page.total).toBe(1875);
  });

  it('clamps requested pages to the available range', () => {
    const items = ['a', 'b', 'c'];

    expect(paginateResults(items, 0, 2)).toMatchObject({
      items: ['a', 'b'],
      page: 1,
      pageCount: 2,
      start: 1,
      end: 2,
    });
    expect(paginateResults(items, 99, 2)).toMatchObject({
      items: ['c'],
      page: 2,
      pageCount: 2,
      start: 3,
      end: 3,
    });
  });

  it('returns a stable empty range for empty input', () => {
    expect(paginateResults([], 3)).toEqual({
      items: [],
      page: 1,
      pageCount: 1,
      total: 0,
      start: 0,
      end: 0,
    });
  });
});
