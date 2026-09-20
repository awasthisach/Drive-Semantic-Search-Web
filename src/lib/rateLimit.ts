/**
 * Google Drive API-friendly fetch with exponential backoff on 429 / 403 rate limits.
 */

export function isRateLimitStatus(status: number): boolean {
  return status === 429 || status === 403;
}

export async function sleep(ms: number): Promise<void> {
  await new Promise(r => setTimeout(r, ms));
}

/**
 * Fetch with retries. Honors Retry-After (seconds) when present.
 * Only retries rate-limit style failures; other 4xx/5xx throw after last attempt.
 */
export async function fetchWithBackoff(
  input: RequestInfo | URL,
  init?: RequestInit,
  opts: { maxRetries?: number; baseMs?: number; label?: string } = {}
): Promise<Response> {
  const maxRetries = opts.maxRetries ?? 5;
  const baseMs = opts.baseMs ?? 500;
  let last: Response | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(input, init);
    last = res;
    if (res.ok) return res;
    if (!isRateLimitStatus(res.status) || attempt === maxRetries) {
      return res;
    }
    const retryAfter = res.headers.get('Retry-After');
    let waitMs = baseMs * Math.pow(2, attempt);
    if (retryAfter) {
      const sec = parseInt(retryAfter, 10);
      if (!Number.isNaN(sec) && sec > 0) waitMs = Math.max(waitMs, sec * 1000);
    }
    // jitter ±25%
    waitMs = Math.round(waitMs * (0.75 + Math.random() * 0.5));
    waitMs = Math.min(waitMs, 60_000);
    console.warn(
      `[rateLimit] ${opts.label || 'Drive API'} ${res.status}, retry ${attempt + 1}/${maxRetries} in ${waitMs}ms`
    );
    await sleep(waitMs);
  }
  return last!;
}
