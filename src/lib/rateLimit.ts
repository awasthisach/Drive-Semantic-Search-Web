/** Google Drive / API rate-limit helpers: exponential backoff + jitter + Retry-After. */

export function isRateLimitStatus(status: number): boolean {
  return status === 429;
}

export async function isRateLimitResponse(response: Response): Promise<boolean> {
  if (response.status === 429) return true;
  if (response.status !== 403) return false;
  try {
    const body = await response.clone().json();
    const reasons: string[] = (body?.error?.errors || []).map((error: { reason?: string }) => error.reason || '');
    return reasons.some(reason => /^(rateLimitExceeded|userRateLimitExceeded|sharingRateLimitExceeded)$/i.test(reason));
  } catch {
    return false;
  }
}

export async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export type BackoffOpts = {
  maxRetries?: number;
  baseMs?: number;
  label?: string;
  /** Soft timeout per attempt (ms). Does not replace AbortSignal. */
  timeoutMs?: number;
};

/**
 * fetch with exponential backoff on safe reads that receive 429 / explicitly
 * identified rate-limit 403. Mutating methods are returned without retry to
 * avoid duplicating resource creation after an ambiguous request outcome.
 * Pass AbortSignal via init.signal — aborted requests are not retried.
 */
export async function fetchWithBackoff(
  input: RequestInfo | URL,
  init?: RequestInit,
  opts: BackoffOpts = {}
): Promise<Response> {
  const maxRetries = opts.maxRetries ?? 5;
  const baseMs = opts.baseMs ?? 500;
  let last: Response | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (init?.signal?.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError');
    }

    let attemptInit = init;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      const ctrl = new AbortController();
      const parent = init?.signal;
      if (parent) {
        if (parent.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
        parent.addEventListener('abort', () => ctrl.abort(), { once: true });
      }
      timeoutId = setTimeout(() => ctrl.abort(), opts.timeoutMs);
      attemptInit = { ...init, signal: ctrl.signal };
    }

    try {
      const res = await fetch(input, attemptInit);
      last = res;
      if (res.ok) return res;
      const method = (init?.method || 'GET').toUpperCase();
      const retrySafe = method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
      if (!retrySafe || !(await isRateLimitResponse(res)) || attempt === maxRetries) {
        return res;
      }
      const retryAfter = res.headers.get('Retry-After');
      let waitMs = baseMs * Math.pow(2, attempt);
      if (retryAfter) {
        const sec = parseInt(retryAfter, 10);
        if (!Number.isNaN(sec) && sec > 0) waitMs = Math.max(waitMs, sec * 1000);
      }
      waitMs = Math.round(waitMs * (0.75 + Math.random() * 0.5));
      waitMs = Math.min(waitMs, 60_000);
      console.warn(
        `[rateLimit] ${opts.label || 'Drive API'} ${res.status}, retry ${attempt + 1}/${maxRetries} in ${waitMs}ms`
      );
      await sleep(waitMs);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }
  return last!;
}
