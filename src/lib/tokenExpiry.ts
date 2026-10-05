/** Treat missing expiry metadata as expired: token lifetime must never be assumed. */
export function isAccessTokenExpired(
  token: string | null,
  expiresAt: number,
  now = Date.now()
): boolean {
  if (!token || !Number.isFinite(expiresAt) || expiresAt <= 0) return true;
  return now >= expiresAt - 60_000;
}
