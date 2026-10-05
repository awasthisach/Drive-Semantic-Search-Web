import { describe, expect, it } from 'vitest';
import { isAccessTokenExpired } from '../tokenExpiry';

describe('isAccessTokenExpired', () => {
  const now = 1_000_000;

  it('treats missing token or expiry metadata as expired', () => {
    expect(isAccessTokenExpired(null, now + 3_600_000, now)).toBe(true);
    expect(isAccessTokenExpired('token', 0, now)).toBe(true);
  });

  it('treats tokens within the refresh safety window as expired', () => {
    expect(isAccessTokenExpired('token', now + 30_000, now)).toBe(true);
  });

  it('accepts a token with more than one minute remaining', () => {
    expect(isAccessTokenExpired('token', now + 120_000, now)).toBe(false);
  });
});
