export function getFirebaseAuthErrorCode(error: unknown): string {
  if (!error || typeof error !== 'object') return 'unknown';
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && /^auth\/[a-z0-9-]+$/.test(code)
    ? code
    : 'unknown';
}

export function describeFirebaseAuthFailure(error: unknown): string {
  return `Firebase session link failed (${getFirebaseAuthErrorCode(error)})`;
}
