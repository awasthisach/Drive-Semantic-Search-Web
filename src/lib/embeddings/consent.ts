/**
 * Explicit, persisted consent for sending Drive/OCR text to the embedding worker.
 * Default is not_decided → no content leaves the browser for embeddings.
 */

export type EmbeddingConsentState = 'not_decided' | 'granted' | 'revoked';

export interface EmbeddingConsent {
  state: EmbeddingConsentState;
  provider: 'drive-semantic-embed-worker';
  purpose: 'semantic_search';
  scope: 'selected_corpus' | 'selected_files';
  grantedAt?: string;
  revokedAt?: string;
  policyVersion: string;
}

/** Bump when consent modal text / payload policy changes so old grants expire. */
export const EMBEDDING_CONSENT_POLICY_VERSION = '1';

const LS_KEY = 'dssw-embedding-consent-v1';

/** In-memory fallback when localStorage is unavailable (tests / private mode). */
let memoryConsent: EmbeddingConsent | null = null;

export interface EmbeddingPolicy {
  canSendContent(): boolean;
  getConsentVersion(): string | null;
  getState(): EmbeddingConsentState;
}

export class ConsentRequiredError extends Error {
  readonly name = 'ConsentRequiredError';
  constructor(message = 'Embedding content consent is required') {
    super(message);
  }
}

function readRaw(): EmbeddingConsent | null {
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as EmbeddingConsent;
        if (parsed && typeof parsed.state === 'string') {
          memoryConsent = parsed;
          return parsed;
        }
      }
    }
  } catch {
    /* fall through to memory */
  }
  return memoryConsent;
}

function writeRaw(next: EmbeddingConsent): void {
  memoryConsent = next;
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(LS_KEY, JSON.stringify(next));
    }
  } catch {
    /* private mode — memory only */
  }
}

export function getEmbeddingConsent(): EmbeddingConsent {
  const stored = readRaw();
  if (!stored) {
    return {
      state: 'not_decided',
      provider: 'drive-semantic-embed-worker',
      purpose: 'semantic_search',
      scope: 'selected_corpus',
      policyVersion: EMBEDDING_CONSENT_POLICY_VERSION,
    };
  }
  if (
    stored.state === 'granted' &&
    stored.policyVersion !== EMBEDDING_CONSENT_POLICY_VERSION
  ) {
    return {
      ...stored,
      state: 'not_decided',
      policyVersion: EMBEDDING_CONSENT_POLICY_VERSION,
    };
  }
  return stored;
}

export function isEmbeddingConsentGranted(): boolean {
  const c = getEmbeddingConsent();
  return c.state === 'granted' && c.policyVersion === EMBEDDING_CONSENT_POLICY_VERSION;
}

export function grantEmbeddingConsent(scope: EmbeddingConsent['scope'] = 'selected_corpus'): EmbeddingConsent {
  const next: EmbeddingConsent = {
    state: 'granted',
    provider: 'drive-semantic-embed-worker',
    purpose: 'semantic_search',
    scope,
    grantedAt: new Date().toISOString(),
    policyVersion: EMBEDDING_CONSENT_POLICY_VERSION,
  };
  writeRaw(next);
  return next;
}

export function revokeEmbeddingConsent(): EmbeddingConsent {
  const prev = getEmbeddingConsent();
  const next: EmbeddingConsent = {
    state: 'revoked',
    provider: 'drive-semantic-embed-worker',
    purpose: 'semantic_search',
    scope: prev.scope || 'selected_corpus',
    grantedAt: prev.grantedAt,
    revokedAt: new Date().toISOString(),
    policyVersion: EMBEDDING_CONSENT_POLICY_VERSION,
  };
  writeRaw(next);
  return next;
}

/** Test helper: clear memory + storage. */
export function resetEmbeddingConsentForTests(): void {
  memoryConsent = null;
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(LS_KEY);
  } catch {
    /* ignore */
  }
}

export function createEmbeddingPolicy(): EmbeddingPolicy {
  return {
    canSendContent(): boolean {
      return isEmbeddingConsentGranted();
    },
    getConsentVersion(): string | null {
      const c = getEmbeddingConsent();
      return c.state === 'granted' ? c.policyVersion : null;
    },
    getState(): EmbeddingConsentState {
      return getEmbeddingConsent().state;
    },
  };
}

/** Always-allow policy for unit tests that mock the network layer. */
export function allowAllEmbeddingPolicy(): EmbeddingPolicy {
  return {
    canSendContent: () => true,
    getConsentVersion: () => EMBEDDING_CONSENT_POLICY_VERSION,
    getState: () => 'granted',
  };
}
