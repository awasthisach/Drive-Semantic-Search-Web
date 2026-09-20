import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchWithBackoff, isRateLimitStatus } from '../rateLimit';

describe('isRateLimitStatus', () => {
  it('detects 429 and 403', () => {
    expect(isRateLimitStatus(429)).toBe(true);
    expect(isRateLimitStatus(403)).toBe(true);
    expect(isRateLimitStatus(401)).toBe(false);
    expect(isRateLimitStatus(200)).toBe(false);
  });
});

describe('fetchWithBackoff', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns ok response without retry', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await fetchWithBackoff('https://example.com', undefined, { maxRetries: 2, baseMs: 10 });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries on 429 then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('rate', { status: 429 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const p = fetchWithBackoff('https://example.com', undefined, { maxRetries: 3, baseMs: 20 });
    await vi.runAllTimersAsync();
    const res = await p;
    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('throws AbortError when signal already aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    vi.stubGlobal('fetch', vi.fn());
    await expect(
      fetchWithBackoff('https://example.com', { signal: ctrl.signal }, { maxRetries: 1 })
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
