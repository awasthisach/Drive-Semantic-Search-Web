import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const auth: { currentUser: any } = { currentUser: null };
  const signInWithPopup = vi.fn();
  const signInWithCredential = vi.fn();
  const requestAccessToken = vi.fn();

  class MockGoogleAuthProvider {
    addScope = vi.fn();
    setCustomParameters = vi.fn();
    static credential = vi.fn((idToken: string | null, accessToken: string | null) => ({ idToken, accessToken }));
    static credentialFromResult = vi.fn((result: any) => result.credential);
  }

  return {
    auth,
    signInWithPopup,
    signInWithCredential,
    requestAccessToken,
    MockGoogleAuthProvider,
    initializeApp: vi.fn(() => ({})),
    getApps: vi.fn(() => []),
    getApp: vi.fn(() => ({})),
    getAuth: vi.fn(() => auth),
    signInWithRedirect: vi.fn(),
    getRedirectResult: vi.fn(async () => null),
    onAuthStateChanged: vi.fn(),
    signOut: vi.fn(async () => undefined),
  };
});

vi.mock('firebase/app', () => ({
  initializeApp: mocks.initializeApp,
  getApps: mocks.getApps,
  getApp: mocks.getApp,
}));

vi.mock('firebase/auth', () => ({
  getAuth: mocks.getAuth,
  signInWithPopup: mocks.signInWithPopup,
  signInWithCredential: mocks.signInWithCredential,
  signInWithRedirect: mocks.signInWithRedirect,
  getRedirectResult: mocks.getRedirectResult,
  onAuthStateChanged: mocks.onAuthStateChanged,
  signOut: mocks.signOut,
  GoogleAuthProvider: mocks.MockGoogleAuthProvider,
}));

vi.mock('../diagnostics', () => ({ logDiag: vi.fn() }));

describe('googleSignIn Firebase credential handling', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.auth.currentUser = null;
    mocks.signInWithCredential.mockRejectedValue({ code: 'auth/invalid-credential' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('surfaces Firebase credential rejection without opening the invalid-action popup loop', async () => {
    const popupUser = { email: 'user@example.com', displayName: 'Test User' };

    const initTokenClient = vi.fn(({ callback }: { callback: (response: any) => Promise<void> }) => ({
      requestAccessToken: (config: Record<string, unknown>) => {
        mocks.requestAccessToken(config);
        void callback({ access_token: 'gsi-drive-token', expires_in: 3600 });
      },
    }));
    vi.stubGlobal('window', { google: { accounts: { oauth2: { initTokenClient } } } });
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ email: popupUser.email, name: popupUser.displayName }),
    })));

    const { googleSignIn } = await import('../firebaseAuth');
    await expect(googleSignIn()).rejects.toThrow('firebase-link-failed');

    expect(mocks.signInWithCredential).toHaveBeenCalledTimes(1);
    expect(mocks.signInWithPopup).not.toHaveBeenCalled();
    expect(mocks.requestAccessToken).toHaveBeenCalledWith({ prompt: 'select_account' });
  });
});
