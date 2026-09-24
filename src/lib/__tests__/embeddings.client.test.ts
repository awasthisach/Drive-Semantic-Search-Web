import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BackendEmbeddingProvider } from '../embeddings/client';
import { EMBED_CONFIG } from '../embeddings/config';

const vector = new Array(EMBED_CONFIG.dimension).fill(0.1);

function response() {
  return new Response(
    JSON.stringify({
      embeddings: [vector],
      model: EMBED_CONFIG.model,
      version: EMBED_CONFIG.version,
      dimension: EMBED_CONFIG.dimension,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

describe('BackendEmbeddingProvider', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('sends document mode without the unsupported taskType field', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response());
    const provider = new BackendEmbeddingProvider(async () => 'firebase-token');
    await provider.embedDocuments(['document body']);

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({ texts: ['document body'], mode: 'document', version: EMBED_CONFIG.version });
    expect(body.taskType).toBeUndefined();
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer firebase-token');
  });

  it('sends query mode for query embeddings', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response());
    const provider = new BackendEmbeddingProvider(async () => 'firebase-token');
    await provider.embedQuery('search phrase');

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ texts: ['search phrase'], mode: 'query', version: EMBED_CONFIG.version });
  });

  it('rejects a response from a stale embedding version', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ embeddings: [vector], model: EMBED_CONFIG.model, version: '1', dimension: EMBED_CONFIG.dimension }), { status: 200 })
    );
    const provider = new BackendEmbeddingProvider(async () => 'firebase-token');
    await expect(provider.embedQuery('stale')).rejects.toThrow(/version mismatch/i);
  });
});
