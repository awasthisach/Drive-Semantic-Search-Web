import { describe, expect, it } from 'vitest';
import { checkRateLimitBucket } from '../../../workers/embed/src/rateLimit';

describe('Durable Object rate-limit bucket', () => {
  it('allows up to the configured limit and denies the next request', () => {
    let bucket = { count: 0, resetAt: 60_000 };
    for (let i = 0; i < 30; i++) {
      const decision = checkRateLimitBucket(bucket, 1_000, 30);
      expect(decision.allowed).toBe(true);
      bucket = decision.bucket;
    }

    const blocked = checkRateLimitBucket(bucket, 1_000, 30);
    expect(blocked.allowed).toBe(false);
    expect(blocked.bucket.count).toBe(30);
    expect(blocked.retryAfterSeconds).toBe(59);
    expect(blocked.logLimitEvent).toBe(true);
  });

  it('emits only one limit event per user bucket window', () => {
    const first = checkRateLimitBucket(
      { count: 30, resetAt: 60_000 },
      1_000,
      30
    );
    const repeated = checkRateLimitBucket(first.bucket, 2_000, 30);

    expect(first.logLimitEvent).toBe(true);
    expect(repeated.allowed).toBe(false);
    expect(repeated.logLimitEvent).toBe(false);
    expect(repeated.bucket.count).toBe(30);
  });

  it('resets an expired bucket and starts the next fixed window', () => {
    const next = checkRateLimitBucket(
      { count: 30, resetAt: 60_000, limitEventLogged: true },
      60_000,
      30
    );

    expect(next.allowed).toBe(true);
    expect(next.bucket).toEqual({ count: 1, resetAt: 120_000, limitEventLogged: false });
    expect(next.logLimitEvent).toBe(false);
  });
});
