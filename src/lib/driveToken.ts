/** Resolve a valid Drive token for an operation, preferring the refresh callback over cached UI state. */
export async function resolveDriveAccessToken(
  cachedToken: string | null,
  requestToken?: () => Promise<string | null>
): Promise<string | null> {
  if (!requestToken) return cachedToken;
  return requestToken();
}
