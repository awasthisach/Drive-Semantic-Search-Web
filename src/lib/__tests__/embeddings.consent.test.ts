import { describe, it, expect, beforeEach } from 'vitest';
import {
  getEmbeddingConsent,
  grantEmbeddingConsent,
  revokeEmbeddingConsent,
  isEmbeddingConsentGranted,
  createEmbeddingPolicy,
  EMBEDDING_CONSENT_POLICY_VERSION,
  ConsentRequiredError,
} from '../embeddings/consent';
import { BackendEmbeddingProvider } from '../embeddings/client';

describe('embedding consent policy', () => {
  beforeEach(() => {
    try {
      localStorage.clear();
    } catch {
      /* ignore */
    }
  });

  it('defaults to not_decided and blocks content', () => {
    const c = getEmbeddingConsent();
    expect(c.state).toBe('not_decided');
    expect(isEmbeddingConsentGranted()).toBe(false);
    expect(createEmbeddingPolicy().canSendContent()).toBe(false);
  });

  it('grant enables content; revoke disables', () => {
    grantEmbeddingConsent('selected_corpus');
    expect(isEmbeddingConsentGranted()).toBe(true);
    expect(createEmbeddingPolicy().canSendContent()).toBe(true);
    expect(createEmbeddingPolicy().getConsentVersion()).toBe(EMBEDDING_CONSENT_POLICY_VERSION);

    revokeEmbeddingConsent();
    expect(isEmbeddingConsentGranted()).toBe(false);
    expect(createEmbeddingPolicy().canSendContent()).toBe(false);
  });

  it('BackendEmbeddingProvider throws ConsentRequiredError without grant', async () => {
    const provider = new BackendEmbeddingProvider(async () => 'fake-token', createEmbeddingPolicy());
    await expect(provider.embedDocuments(['hello world'])).rejects.toBeInstanceOf(ConsentRequiredError);
  });
});
