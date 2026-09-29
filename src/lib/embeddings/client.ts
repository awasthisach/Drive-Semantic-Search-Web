import { EMBED_CONFIG, isEmbedConfigured } from './config';
import { sleep } from '../rateLimit';
import type { EmbedRequest, EmbedResponse, EmbeddingProvider } from './types';

export class EmbedConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbedConfigError';
  }
}

export class EmbedAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbedAuthError';
  }
}

export class EmbedApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'EmbedApiError';
    this.status = status;
  }
}

/**
 * Calls the authenticated backend /embed endpoint.
 * API keys never live in the browser — only a Firebase ID token is sent.
 */
export class BackendEmbeddingProvider implements EmbeddingProvider {
  readonly embeddingModel = EMBED_CONFIG.model;
  readonly embeddingVersion = EMBED_CONFIG.version;
  readonly dimension = EMBED_CONFIG.dimension;

  constructor(private readonly getIdToken: () => Promise<string | null>) {}

  async embedDocuments(texts: string[]): Promise<number[][]> {
    return this.embed(texts, 'document');
  }

  async embedQuery(text: string): Promise<number[]> {
    const rows = await this.embed([text], 'query');
    return rows[0] || [];
  }

  private async embed(
    texts: string[],
    mode: EmbedRequest['mode']
  ): Promise<number[][]> {
    if (!isEmbedConfigured()) {
      throw new EmbedConfigError(
        'VITE_EMBED_ENDPOINT is not set. Deploy workers/embed and set the public URL.'
      );
    }
    if (!texts.length) return [];

    const cleaned = texts.map(t =>
      (t || '').slice(0, EMBED_CONFIG.maxCharsPerText)
    );
    if (cleaned.length > EMBED_CONFIG.maxTextsPerBatch) {
      throw new EmbedApiError(
        400,
        `Batch too large (max ${EMBED_CONFIG.maxTextsPerBatch})`
      );
    }

    const body: EmbedRequest = { texts: cleaned, mode, version: EMBED_CONFIG.version };
    const maxRetries = 5;
    const timeoutMs = 45_000;

    // The embedding endpoint is a pure computation endpoint: retrying the same
    // request after a timeout/429/5xx cannot create duplicate Drive resources.
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const token = await this.getIdToken();
      if (!token) {
        throw new EmbedAuthError('Sign in required to generate embeddings');
      }

      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(EMBED_CONFIG.endpoint, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + token,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (res.ok) {
          const data = (await res.json()) as EmbedResponse;
          if (!data?.embeddings || !Array.isArray(data.embeddings)) {
            throw new EmbedApiError(502, 'Invalid embed response shape');
          }
          if (data.embeddings.length !== cleaned.length) {
            throw new EmbedApiError(502, 'Embed response length mismatch');
          }
          for (const row of data.embeddings) {
            if (
              !Array.isArray(row) ||
              row.length !== EMBED_CONFIG.dimension ||
              row.some(value => !Number.isFinite(value))
            ) {
              throw new EmbedApiError(
                502,
                `Embed dimension mismatch (expected ${EMBED_CONFIG.dimension}, got ${Array.isArray(row) ? row.length : 0})`
              );
            }
          }
          if (data.model !== EMBED_CONFIG.model) {
            throw new EmbedApiError(502, `Embed model mismatch (expected ${EMBED_CONFIG.model}, got ${data.model})`);
          }
          if (data.version !== EMBED_CONFIG.version) {
            throw new EmbedApiError(502, `Embed version mismatch (expected ${EMBED_CONFIG.version}, got ${data.version})`);
          }
          if (data.dimension !== EMBED_CONFIG.dimension) {
            throw new EmbedApiError(502, `Embed dimension metadata mismatch (expected ${EMBED_CONFIG.dimension}, got ${data.dimension})`);
          }
          return data.embeddings;
        }

        if ((res.status === 401 || res.status === 403) && res.status !== 429) {
          throw new EmbedAuthError('Embedding auth failed (' + res.status + ')');
        }

        const retryable = res.status === 408 || res.status === 425 || res.status === 429 || res.status >= 500;
        if (!retryable || attempt === maxRetries) {
          const msg = await res.text().catch(() => res.statusText);
          throw new EmbedApiError(res.status, msg.slice(0, 200));
        }

        const retryAfter = res.headers.get('Retry-After');
        let waitMs = 1_000 * Math.pow(2, attempt);
        if (retryAfter) {
          const sec = parseInt(retryAfter, 10);
          if (!Number.isNaN(sec) && sec > 0) waitMs = Math.max(waitMs, sec * 1_000);
        }
        waitMs = Math.min(Math.round(waitMs * (0.75 + Math.random() * 0.5)), 60_000);
        console.warn(`[embedding] ${res.status}, retry ${attempt + 1}/${maxRetries} in ${waitMs}ms`);
        await sleep(waitMs);
      } catch (error) {
        if (error instanceof EmbedApiError || error instanceof EmbedAuthError) throw error;
        if (attempt === maxRetries) {
          throw new EmbedApiError(408, 'Embedding request timed out after retries');
        }
        const waitMs = Math.min(
          Math.round(1_000 * Math.pow(2, attempt) * (0.75 + Math.random() * 0.5)),
          60_000
        );
        console.warn(`[embedding] timeout/network error, retry ${attempt + 1}/${maxRetries} in ${waitMs}ms`);
        await sleep(waitMs);
      } finally {
        window.clearTimeout(timeout);
      }
    }

    throw new EmbedApiError(408, 'Embedding request timed out after retries');
  }
}

/** Factory used by future indexing/search wiring (Phase 4). */
export function createEmbeddingProvider(
  getIdToken: () => Promise<string | null>
): EmbeddingProvider {
  return new BackendEmbeddingProvider(getIdToken);
}
