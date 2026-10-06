import { describe, expect, it } from 'vitest';
import {
  describeFirebaseAuthFailure,
  getFirebaseAuthErrorCode,
} from '../firebaseAuthDiagnostics';

describe('firebaseAuthDiagnostics', () => {
  it('keeps a valid Firebase auth code and excludes the raw error message', () => {
    const error = {
      code: 'auth/unauthorized-domain',
      message: 'private message Bearer ya29.secret user@example.com',
    };

    expect(getFirebaseAuthErrorCode(error)).toBe('auth/unauthorized-domain');
    expect(describeFirebaseAuthFailure(error)).toBe(
      'Firebase session link failed (auth/unauthorized-domain)',
    );
    expect(describeFirebaseAuthFailure(error)).not.toContain('ya29.secret');
    expect(describeFirebaseAuthFailure(error)).not.toContain('user@example.com');
  });

  it('uses unknown for malformed or absent error codes', () => {
    expect(getFirebaseAuthErrorCode({ code: 'Bearer ya29.secret' })).toBe('unknown');
    expect(getFirebaseAuthErrorCode(new Error('network failure'))).toBe('unknown');
    expect(getFirebaseAuthErrorCode(null)).toBe('unknown');
  });
});
