/** Typed Drive API failure for handler branching. */
export class DriveApiError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  constructor(status: number, message: string, retryable?: boolean) {
    super(message);
    this.name = 'DriveApiError';
    this.status = status;
    this.retryable = retryable ?? (status === 429 || status >= 500);
  }
}

export function isDriveApiError(e: unknown): e is DriveApiError {
  return e instanceof DriveApiError;
}
