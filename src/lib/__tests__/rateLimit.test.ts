import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchWithBackoff, isRateLimitStatus } from '../rateLimit';

describe('isRateLimitStatus', () => {
  it('detects HTTP 429 without treating all 403 responses as rate limits', () => {
    expect(isRateLimitStatus(429)).toBe(true);
    expect(isRateLimitStatus(403)).toBe(false);
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

  it('retries a transient network failure on safe reads', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const p = fetchWithBackoff('https://example.com', undefined, { maxRetries: 3, baseMs: 10 });
    await vi.runAllTimersAsync();
    expect((await p).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry a permission-denied 403', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: 'forbidden' } }), { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await fetchWithBackoff('https://example.com', undefined, { maxRetries: 3, baseMs: 10 });
    expect(res.status).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a 403 carrying a recognized Drive rate-limit reason', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { errors: [{ reason: 'userRateLimitExceeded' }] } }), { status: 403 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const promise = fetchWithBackoff('https://example.com', undefined, { maxRetries: 1, baseMs: 10 });
    await vi.runAllTimersAsync();
    expect((await promise).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry a non-idempotent POST after a rate-limit response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('rate limited', { status: 429 }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await fetchWithBackoff('https://example.com', { method: 'POST' }, { maxRetries: 3, baseMs: 10 });
    expect(res.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry a non-idempotent POST after a network failure', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      fetchWithBackoff('https://example.com', { method: 'POST' }, { maxRetries: 3, baseMs: 10 })
    ).rejects.toThrow('Failed to fetch');
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
