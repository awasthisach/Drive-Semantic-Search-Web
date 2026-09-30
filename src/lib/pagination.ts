export const SEARCH_RESULTS_PAGE_SIZE = 50;

export interface PaginatedResults<T> {
  items: T[];
  page: number;
  pageCount: number;
  total: number;
  start: number;
  end: number;
}

/**
 * Return one bounded page of results while keeping page/range values safe for
 * empty collections and callers that pass an invalid page number.
 */
export function paginateResults<T>(
  items: readonly T[],
  requestedPage = 1,
  pageSize = SEARCH_RESULTS_PAGE_SIZE
): PaginatedResults<T> {
  const safePageSize = Number.isFinite(pageSize) && pageSize > 0 ? Math.floor(pageSize) : SEARCH_RESULTS_PAGE_SIZE;
  const pageCount = Math.max(1, Math.ceil(items.length / safePageSize));
  const page = Number.isFinite(requestedPage)
    ? Math.min(pageCount, Math.max(1, Math.floor(requestedPage)))
    : 1;
  const startOffset = (page - 1) * safePageSize;
  const pageItems = items.slice(startOffset, startOffset + safePageSize);

  return {
    items: pageItems,
    page,
    pageCount,
    total: items.length,
    start: pageItems.length ? startOffset + 1 : 0,
    end: pageItems.length ? startOffset + pageItems.length : 0,
  };
}
