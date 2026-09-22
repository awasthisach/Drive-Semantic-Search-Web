import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  getAuth,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  GoogleAuthProvider,
  onAuthStateChanged,
  User,
  signOut,
} from 'firebase/auth';
import firebaseConfig from '../../firebase-applet-config.json';

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();
export const auth = getAuth(app);

export const SCOPES = [
  'https://www.googleapis.com/auth/drive',
];

const provider = new GoogleAuthProvider();
for (const scope of SCOPES) {
  provider.addScope(scope);
}
provider.setCustomParameters({
  prompt: 'select_account',
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
  if (!cachedAccessToken) return true;
  if (!tokenExpiresAt) return false;
  return Date.now() >= tokenExpiresAt - 60_000;
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

          try {
            const userRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
              headers: { Authorization: `Bearer ${accessToken}` },
            });
            if (userRes.ok) {
              const userData = await userRes.json();
              resolve({
                user: {
                  displayName: userData.name || 'Google Drive User',
                  email: userData.email || '',
                  photoURL: userData.picture || '',
                } as any,
                accessToken,
              });
              return;
            }
          } catch {
            // fallback
          }

          resolve({
            user: {
              displayName: 'Google Drive User',
              email: '',
              photoURL: '',
            } as any,
            accessToken,
          });
        },
      });

      tokenClient.requestAccessToken({ prompt: '' });
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
      if (cachedAccessToken) {
        if (onAuthSuccess) onAuthSuccess(user, cachedAccessToken);
      } else if (!isSigningIn) {
        if (onAuthFailure) onAuthFailure();
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
        gsiErr?.message?.includes('closed') ||
        gsiErr?.error === 'access_denied';

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
    return cachedAccessToken;
  }
  const google = (window as any).google;
  if (!google?.accounts?.oauth2) {
    return cachedAccessToken;
  }

  return new Promise((resolve) => {
    try {
      const tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: cid,
        scope: SCOPES.join(' '),
        callback: (tokenResponse: any) => {
          if (tokenResponse.error || !tokenResponse.access_token) {
            console.warn('Silent token refresh failed:', tokenResponse.error);
            resolve(cachedAccessToken);
            return;
          }
          const expiresIn = Number(tokenResponse.expires_in) || 3600;
          persistToken(tokenResponse.access_token, expiresIn);
          resolve(tokenResponse.access_token);
        },
      });
      tokenClient.requestAccessToken({ prompt: '' });
    } catch (e) {
      console.warn('ensureValidToken error:', e);
      resolve(cachedAccessToken);
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

/** Firebase Auth ID token for backend /embed (not the Drive access token). */
export async function getFirebaseIdToken(forceRefresh = false): Promise<string | null> {
  const user = auth.currentUser;
  if (!user) return null;
  try {
    return await user.getIdToken(forceRefresh);
  } catch (e) {
    console.warn('[firebaseAuth] getIdToken failed', e);
    return null;
  }
}
