import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  getAuth,
  signInWithPopup,
  signInWithRedirect,
  signInWithCredential,
  getRedirectResult,
  GoogleAuthProvider,
  onAuthStateChanged,
  User,
  signOut,
} from 'firebase/auth';
import firebaseConfig from '../../firebase-applet-config.json';
import { isAccessTokenExpired } from './tokenExpiry';

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();
export const auth = getAuth(app);

export const SCOPES = [
  'https://www.googleapis.com/auth/drive',
];

/** Preferred Google account for this VVF deployment's Drive session. */
export const PREFERRED_GOOGLE_ACCOUNT = 'awasthi.sach@gmail.com';

const provider = new GoogleAuthProvider();
for (const scope of SCOPES) {
  provider.addScope(scope);
}
provider.setCustomParameters({
  prompt: 'select_account',
  login_hint: PREFERRED_GOOGLE_ACCOUNT,
});

const TOKEN_KEY = 'gdrive_access_token';
const TOKEN_EXP_KEY = 'gdrive_access_token_exp';
let cachedAccessToken: string | null = (typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(TOKEN_KEY) : null);
let tokenExpiresAt: number = (typeof sessionStorage !== 'undefined'
  ? parseInt(sessionStorage.getItem(TOKEN_EXP_KEY) || '0', 10) || 0
  : 0);
let isSigningIn = false;

function persistToken(token: string | null, expiresInSeconds?: number) {
  cachedAccessToken = token;
  if (token && expiresInSeconds && expiresInSeconds > 0) {
    tokenExpiresAt = Date.now() + expiresInSeconds * 1000;
  } else if (!token) {
    tokenExpiresAt = 0;
  }
  try {
    if (typeof sessionStorage === 'undefined') return;
    if (token) {
      sessionStorage.setItem(TOKEN_KEY, token);
      if (tokenExpiresAt) sessionStorage.setItem(TOKEN_EXP_KEY, String(tokenExpiresAt));
    } else {
      sessionStorage.removeItem(TOKEN_KEY);
      sessionStorage.removeItem(TOKEN_EXP_KEY);
    }
  } catch {
    // ignore
  }
}

function isTokenExpired(): boolean {
  return isAccessTokenExpired(cachedAccessToken, tokenExpiresAt);
}

/**
 * GIS token flow only yields a Drive access token; the embed Worker needs a
 * Firebase ID token, so exchange the Google credential for a Firebase session.
 */
/**
 * Link / refresh Firebase Auth from a Google access token.
 * Verifies that any existing Firebase user matches the Google account (email)
 * represented by this token; otherwise re-authenticates so Drive and embed
 * identity stay aligned.
 */
async function linkFirebaseSession(
  accessToken: string,
  googleEmail?: string | null
): Promise<User | null> {
  const normalized = (googleEmail || '').trim().toLowerCase();
  const current = auth.currentUser;
  if (current) {
    const currentEmail = (current.email || '').trim().toLowerCase();
    if (!normalized || !currentEmail || currentEmail === normalized) {
      return current;
    }
    console.warn(
      '[firebaseAuth] Firebase user email mismatch with Drive account; re-linking',
      { firebase: currentEmail, drive: normalized }
    );
    try {
      await signOut(auth);
    } catch {
      /* ignore */
    }
  }
  try {
    const result = await signInWithCredential(
      auth,
      GoogleAuthProvider.credential(null, accessToken)
    );
    return result.user;
  } catch (e) {
    console.warn(
      '[firebaseAuth] Firebase session link skipped (neural search will be unavailable):',
      e
    );
    return null;
  }
}

export const requestGsiToken = async (clientId: string): Promise<{ user: Partial<User>; accessToken: string }> => {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined') {
      reject(new Error('Window is not defined'));
      return;
    }

    const google = (window as any).google;
    if (!google?.accounts?.oauth2) {
      reject(new Error('Google Identity Services library is still loading. Please try again in 2 seconds.'));
      return;
    }

    try {
      const tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: SCOPES.join(' '),
        callback: async (tokenResponse: any) => {
          if (tokenResponse.error) {
            reject(new Error(tokenResponse.error_description || tokenResponse.error || 'OAuth token request failed'));
            return;
          }
          const accessToken = tokenResponse.access_token;
          if (!accessToken) {
            reject(new Error('No access token received from Google'));
            return;
          }
          const expiresIn = Number(tokenResponse.expires_in) || 3600;
          persistToken(accessToken, expiresIn);

          let googleEmail: string | undefined;
          let googleName: string | undefined;
          let googlePicture: string | undefined;
          try {
            const userRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
              headers: { Authorization: `Bearer ${accessToken}` },
            });
            if (userRes.ok) {
              const userData = await userRes.json();
              googleEmail = userData.email || undefined;
              googleName = userData.name || undefined;
              googlePicture = userData.picture || undefined;
            }
          } catch {
            // userinfo optional for linking
          }

          const firebaseUser = await linkFirebaseSession(accessToken, googleEmail);

          resolve({
            user: {
              displayName: googleName || firebaseUser?.displayName || 'Google Drive User',
              email: googleEmail || firebaseUser?.email || '',
              photoURL: googlePicture || firebaseUser?.photoURL || '',
            } as any,
            accessToken,
          });
        },
      });

      tokenClient.requestAccessToken({ prompt: '', login_hint: PREFERRED_GOOGLE_ACCOUNT });
    } catch (err: any) {
      reject(err);
    }
  });
};

export const initAuth = (
  onAuthSuccess?: (user: User, token: string) => void,
  onAuthFailure?: () => void
) => {
  getRedirectResult(auth)
    .then((result) => {
      if (result) {
        const credential = GoogleAuthProvider.credentialFromResult(result);
        if (credential?.accessToken) {
          persistToken(credential.accessToken, 3600);
          if (onAuthSuccess) onAuthSuccess(result.user, cachedAccessToken!);
        }
      }
    })
    .catch((error) => {
      console.warn('Redirect auth result error:', error);
    });

  return onAuthStateChanged(auth, async (user: User | null) => {
    if (user) {
      if (isSigningIn) return; // interactive sign-in flow owns state updates
      if (cachedAccessToken) {
        if (onAuthSuccess) onAuthSuccess(user, cachedAccessToken);
      } else if (onAuthFailure) {
        onAuthFailure();
      }
    } else {
      persistToken(null);
      if (onAuthFailure) onAuthFailure();
    }
  });
};

export const ensureGsiLoaded = (): Promise<boolean> => {
  return new Promise((resolve) => {
    if (typeof window === 'undefined') return resolve(false);
    if ((window as any).google?.accounts?.oauth2) return resolve(true);

    const existing = document.getElementById('google-gsi-client');
    if (existing) {
      if ((window as any).google?.accounts?.oauth2) return resolve(true);
      existing.addEventListener('load', () => resolve(true), { once: true });
      setTimeout(() => resolve(Boolean((window as any).google?.accounts?.oauth2)), 1500);
      return;
    }

    const script = document.createElement('script');
    script.id = 'google-gsi-client';
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.onload = () => resolve(true);
    script.onerror = () => resolve(false);
    document.head.appendChild(script);
    setTimeout(() => resolve(Boolean((window as any).google?.accounts?.oauth2)), 2000);
  });
};

export const googleSignIn = async (): Promise<{ user: any; accessToken: string } | null> => {
  isSigningIn = true;
  let primaryError: any = null;

  if (typeof window !== 'undefined' && (window as any).google?.accounts?.oauth2 && firebaseConfig.oAuthClientId) {
    try {
      const gsiResult = await requestGsiToken(firebaseConfig.oAuthClientId);
      if (!cachedAccessToken) persistToken(gsiResult.accessToken, 3600);
      return gsiResult;
    } catch (gsiErr: any) {
      const isCancelled =
        gsiErr?.message?.includes('user_cancel') ||
        gsiErr?.error === 'access_denied' ||
        gsiErr?.message?.includes('closed');

      if (isCancelled) {
        console.info('GSI sign-in dismissed by user.');
        return null;
      }
      console.warn('GSI token request skipped, trying Firebase popup fallback:', gsiErr?.message || gsiErr);
      primaryError = gsiErr;
    }
  }

  try {
    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (!credential?.accessToken) {
      throw new Error('Could not obtain OAuth access token for Google Drive');
    }
    persistToken(credential.accessToken, 3600);
    await linkFirebaseSession(credential.accessToken, result.user.email);
    return { user: result.user, accessToken: cachedAccessToken! };
  } catch (error: any) {
    const isPopupError =
      error?.code === 'auth/popup-closed-by-user' ||
      error?.code === 'auth/popup-blocked' ||
      error?.code === 'auth/cancelled-popup-request' ||
      String(error?.message || '').includes('popup');

    if (isPopupError) {
      console.info('Popup blocked or closed. Falling back to signInWithRedirect...');
      signInWithRedirect(auth, provider);
      return new Promise(() => {});
    }

    console.warn('Google Drive Auth notice:', error?.message || error);
    const err = primaryError ? new Error(`${error.message || error} (GSI: ${primaryError.message})`) : error;
    (err as any).code = error.code || primaryError?.code;
    throw err;
  } finally {
    isSigningIn = false;
  }
};

export const getAccessToken = async (): Promise<string | null> => {
  return cachedAccessToken;
};

export const setCachedAccessToken = (token: string | null, expiresInSeconds?: number) => {
  persistToken(token, expiresInSeconds);
};

/** Returns a valid access token, silently refreshing via GSI when expired. */
export const ensureValidToken = async (clientId?: string): Promise<string | null> => {
  if (cachedAccessToken && !isTokenExpired()) {
    return cachedAccessToken;
  }
  const cid = clientId || (firebaseConfig as any).oAuthClientId;
  if (!cid || typeof window === 'undefined') {
    return null;
  }
  const google = (window as any).google;
  if (!google?.accounts?.oauth2) {
    return null;
  }

  return new Promise((resolve) => {
    try {
      const tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: cid,
        scope: SCOPES.join(' '),
        callback: (tokenResponse: any) => {
          if (tokenResponse.error || !tokenResponse.access_token) {
            console.warn('Silent token refresh failed:', tokenResponse.error);
            resolve(null);
            return;
          }
          const expiresIn = Number(tokenResponse.expires_in) || 3600;
          persistToken(tokenResponse.access_token, expiresIn);
          void linkFirebaseSession(tokenResponse.access_token).catch(() => undefined);
          resolve(tokenResponse.access_token);
        },
      });
      tokenClient.requestAccessToken({ prompt: '', login_hint: PREFERRED_GOOGLE_ACCOUNT });
    } catch (e) {
      console.warn('ensureValidToken error:', e);
      resolve(null);
    }
  });
};

/** Revoke Google OAuth grant for this token. */
export const revokeGoogleAccess = async (): Promise<void> => {
  const token = cachedAccessToken;
  if (token) {
    try {
      await fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(token), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
    } catch (e) {
      console.warn('Token revoke failed:', e);
    }
  }
  persistToken(null);
};

export const googleSignOut = async (options?: { revoke?: boolean }) => {
  if (options?.revoke) {
    await revokeGoogleAccess();
  }
  try {
    await signOut(auth);
  } catch {
    // ignore
  }
  persistToken(null);
};

/** True when Firebase Auth has a current user (required for neural embeddings). */
export function isFirebaseReady(): boolean {
  return Boolean(auth.currentUser);
}

/**
 * Best-effort: if Drive token exists but Firebase is not linked, try linking again.
 */
export async function ensureFirebaseSessionForEmbed(): Promise<boolean> {
  if (auth.currentUser) return true;
  const token = cachedAccessToken;
  if (!token) return false;
  const user = await linkFirebaseSession(token);
  return Boolean(user);
}

/** Firebase Auth ID token for backend /embed (not the Drive access token). */
export async function getFirebaseIdToken(forceRefresh = false): Promise<string | null> {
  if (!auth.currentUser) {
    await ensureFirebaseSessionForEmbed();
  }
  const user = auth.currentUser;
  if (!user) return null;
  try {
    return await user.getIdToken(forceRefresh);
  } catch (e) {
    console.warn('[firebaseAuth] getIdToken failed', e);
    return null;
  }
}
