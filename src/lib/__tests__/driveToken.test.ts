import { describe, expect, it, vi } from 'vitest';
import { resolveDriveAccessToken } from '../driveToken';

describe('resolveDriveAccessToken', () => {
  it('asks for a fresh token even when a cached token exists', async () => {
    const requestToken = vi.fn().mockResolvedValue('fresh-token');
    await expect(resolveDriveAccessToken('possibly-expired-token', requestToken)).resolves.toBe('fresh-token');
    expect(requestToken).toHaveBeenCalledOnce();
  });

  it('does not reuse a cached token if the refresh callback cannot provide a valid one', async () => {
    const requestToken = vi.fn().mockResolvedValue(null);
    await expect(resolveDriveAccessToken('expired-token', requestToken)).resolves.toBeNull();
  });

  it('uses the cached token only when no refresh callback is available', async () => {
    await expect(resolveDriveAccessToken('cached-token')).resolves.toBe('cached-token');
  });
});
