export interface RateLimitBucket {
  count: number;
  resetAt: number;
  limitEventLogged?: boolean;
}

export interface RateLimitDecision {
  allowed: boolean;
  bucket: RateLimitBucket;
  limit: number;
  retryAfterSeconds: number;
  logLimitEvent: boolean;
}

/** Consume one request from a per-user, fixed 60-second Durable Object bucket. */
export function checkRateLimitBucket(
  current: RateLimitBucket | null | undefined,
  now: number,
  configuredLimit: number
): RateLimitDecision {
  const limit = Number.isFinite(configuredLimit)
    ? Math.max(1, Math.min(1000, Math.floor(configuredLimit)))
    : 30;
  const bucket: RateLimitBucket = !current || now >= current.resetAt
    ? { count: 0, resetAt: now + 60_000 }
    : current;

  if (bucket.count >= limit) {
    const logLimitEvent = !bucket.limitEventLogged;
    return {
      allowed: false,
      bucket: logLimitEvent ? { ...bucket, limitEventLogged: true } : bucket,
      limit,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
      logLimitEvent,
    };
  }

  return {
    allowed: true,
    bucket: { count: bucket.count + 1, resetAt: bucket.resetAt, limitEventLogged: false },
    limit,
    retryAfterSeconds: 0,
    logLimitEvent: false,
  };
}
