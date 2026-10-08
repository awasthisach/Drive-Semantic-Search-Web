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
import { logDiag } from './diagnostics';
import { describeFirebaseAuthFailure } from './firebaseAuthDiagnostics';

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();
export const auth = getAuth(app);

export const SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/drive',
];

export const PREFERRED_GOOGLE_ACCOUNT = '';

const provider = new GoogleAuthProvider();
for (const scope of SCOPES) {
  provider.addScope(scope);
}
const providerParams: Record<string, string> = { prompt: 'select_account' };
if (PREFERRED_GOOGLE_ACCOUNT) {
  providerParams.login_hint = PREFERRED_GOOGLE_ACCOUNT;
}
provider.setCustomParameters(providerParams);

const TOKEN_KEY = 'gdrive_access_token';
const TOKEN_EXP_KEY = 'gdrive_access_token_exp';
let cachedAccessToken: string | null = null;
let tokenExpiresAt = 0;
try {
  if (typeof sessionStorage !== 'undefined') {
    cachedAccessToken = sessionStorage.getItem(TOKEN_KEY);
    tokenExpiresAt = parseInt(sessionStorage.getItem(TOKEN_EXP_KEY) || '0', 10) || 0;
  }
} catch {
  /* private mode */
}
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
    /* ignore */
  }
}

function isTokenExpired(): boolean {
  return isAccessTokenExpired(cachedAccessToken, tokenExpiresAt);
}

async function linkFirebaseSession(
  accessToken: string,
  googleEmail?: string | null,
  idToken?: string | null
): Promise<User | null> {
  const normalized = (googleEmail || '').trim().toLowerCase();
  const current = auth.currentUser;
  if (current) {
    const currentEmail = (current.email || '').trim().toLowerCase();
    if (!normalized || !currentEmail || currentEmail === normalized) {
      return current;
    }
    try {
      await signOut(auth);
    } catch {
      /* ignore */
    }
  }
  try {
    const credential = idToken
      ? GoogleAuthProvider.credential(idToken, accessToken)
      : GoogleAuthProvider.credential(null, accessToken);
    const result = await signInWithCredential(auth, credential);
    return result.user;
  } catch (e) {
    logDiag('error', 'firebaseAuth', describeFirebaseAuthFailure(e));
    console.warn('[firebaseAuth] Firebase session link failed', e);
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
            /* optional */
          }
          const googleIdToken =
            typeof tokenResponse.id_token === 'string' ? tokenResponse.id_token : null;
          let firebaseUser = await linkFirebaseSession(accessToken, googleEmail, googleIdToken);
          if (!firebaseUser) {
            firebaseUser = await linkFirebaseSession(accessToken, googleEmail, googleIdToken);
          }
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
      const reqOpts: { prompt: string; login_hint?: string } = { prompt: 'consent' };
      if (PREFERRED_GOOGLE_ACCOUNT) reqOpts.login_hint = PREFERRED_GOOGLE_ACCOUNT;
      tokenClient.requestAccessToken(reqOpts);
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
      if (isSigningIn) return;
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
  try {
    try {
      const result = await signInWithPopup(auth, provider);
      const credential = GoogleAuthProvider.credentialFromResult(result);
      if (!credential?.accessToken) {
        throw new Error('Could not obtain OAuth access token for Google Drive');
      }
      persistToken(credential.accessToken, 3600);
      return { user: result.user, accessToken: credential.accessToken };
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
      console.warn('Firebase popup sign-in failed, trying GSI:', error?.message || error);
      primaryError = error;
    }
    if (typeof window !== 'undefined' && (window as any).google?.accounts?.oauth2 && firebaseConfig.oAuthClientId) {
      await ensureGsiLoaded();
      const gsiResult = await requestGsiToken(firebaseConfig.oAuthClientId);
      if (!cachedAccessToken) persistToken(gsiResult.accessToken, 3600);
      return gsiResult;
    }
    if (primaryError) throw primaryError;
    throw new Error('Google sign-in unavailable');
  } finally {
    isSigningIn = false;
  }
};

export const getAccessToken = async (): Promise<string | null> => cachedAccessToken;

export const setCachedAccessToken = (token: string | null, expiresInSeconds?: number) => {
  persistToken(token, expiresInSeconds);
};

export const ensureValidToken = async (clientId?: string): Promise<string | null> => {
  if (cachedAccessToken && !isTokenExpired()) return cachedAccessToken;
  const cid = clientId || (firebaseConfig as any).oAuthClientId;
  if (!cid || typeof window === 'undefined') return null;
  const google = (window as any).google;
  if (!google?.accounts?.oauth2) return null;
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
      const reqOpts: { prompt: string; login_hint?: string } = { prompt: '' };
      if (PREFERRED_GOOGLE_ACCOUNT) reqOpts.login_hint = PREFERRED_GOOGLE_ACCOUNT;
      tokenClient.requestAccessToken(reqOpts);
    } catch (e) {
      console.warn('ensureValidToken error:', e);
      resolve(null);
    }
  });
};

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
  if (options?.revoke) await revokeGoogleAccess();
  try {
    await signOut(auth);
  } catch {
    /* ignore */
  }
  persistToken(null);
};

export function isFirebaseReady(): boolean {
  return Boolean(auth.currentUser);
}

export async function ensureFirebaseSessionForEmbed(): Promise<boolean> {
  if (auth.currentUser) return true;
  const token = cachedAccessToken;
  if (!token) return false;
  const user = await linkFirebaseSession(token);
  return Boolean(user);
}

export async function getFirebaseIdToken(forceRefresh = false): Promise<string | null> {
  if (!auth.currentUser) await ensureFirebaseSessionForEmbed();
  const user = auth.currentUser;
  if (!user) return null;
  try {
    return await user.getIdToken(forceRefresh);
  } catch (e) {
    console.warn('[firebaseAuth] getIdToken failed', e);
    return null;
  }
}
