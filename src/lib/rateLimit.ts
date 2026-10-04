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
  /** Soft timeout per attempt (ms). Timeout failures are retried for safe reads. */
  timeoutMs?: number;
};

/**
 * Fetch with exponential backoff on safe reads that receive 429 / explicitly
 * identified rate-limit 403, per-attempt timeouts, and short-lived network
 * failures such as "Failed to fetch". Mutating methods are never retried after
 * an ambiguous outcome. Pass AbortSignal via init.signal — caller aborts are
 * never retried.
 */
export async function fetchWithBackoff(
  input: RequestInfo | URL,
  init?: RequestInit,
  opts: BackoffOpts = {}
): Promise<Response> {
  const maxRetries = opts.maxRetries ?? 5;
  const baseMs = opts.baseMs ?? 500;
  const networkRetries = Math.min(maxRetries, 2);
  let last: Response | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (init?.signal?.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError');
    }

    const method = (init?.method || 'GET').toUpperCase();
    const retrySafe = method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
    let attemptInit = init;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      const ctrl = new AbortController();
      const parent = init?.signal;
      if (parent) {
        if (parent.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
        parent.addEventListener('abort', () => ctrl.abort(), { once: true });
      }
      timeoutId = setTimeout(() => {
        timedOut = true;
        ctrl.abort();
      }, opts.timeoutMs);
      attemptInit = { ...init, signal: ctrl.signal };
    }

    try {
      const res = await fetch(input, attemptInit);
      last = res;
      if (res.ok) return res;
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
    } catch (error) {
      if (init?.signal?.aborted) throw error;
      const shouldRetryNetwork =
        retrySafe && !timedOut && attempt < networkRetries;
      const shouldRetryTimeout =
        retrySafe && timedOut && attempt < maxRetries;
      if (!shouldRetryNetwork && !shouldRetryTimeout) {
        throw error;
      }
      const retryAttempt = attempt + 1;
      const waitMs = Math.min(
        Math.round(baseMs * Math.pow(2, attempt) * (0.75 + Math.random() * 0.5)),
        60_000
      );
      const reason = timedOut ? 'timeout' : (error instanceof Error ? error.message : String(error));
      console.warn(
        `[rateLimit] ${opts.label || 'Drive API'} network/timeout error (${reason}), retry ${retryAttempt}/${timedOut ? maxRetries : networkRetries} in ${waitMs}ms`
      );
      await sleep(waitMs);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }
  return last!;
}
