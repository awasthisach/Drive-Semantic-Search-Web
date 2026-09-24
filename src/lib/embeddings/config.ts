/**
 * Public embed client config only.
 * Never put GEMINI_API_KEY (or any secret) in VITE_* vars or the SPA bundle.
 *
 * Model id MUST match workers/embed EMBED_MODEL default (gemini-embedding-2).
 */
const DEFAULT_PRODUCTION_EMBED_ENDPOINT =
  'https://drive-semantic-embed.awasthi-sach.workers.dev';

function readEmbedEndpoint(): string {
  try {
    const env = (import.meta as unknown as { env?: Record<string, string> }).env;
    const fromEnv = (env && env.VITE_EMBED_ENDPOINT) || '';
    if (fromEnv.startsWith('http')) return fromEnv.replace(/\/$/, '');
  } catch {
    /* ignore */
  }
  return DEFAULT_PRODUCTION_EMBED_ENDPOINT;
}

/** Canonical model id — keep in sync with workers/embed wrangler default. */
export const EMBED_MODEL_ID = 'gemini-embedding-2' as const;
export const EMBED_VERSION = '3' as const;
export const EMBED_DIMENSION = 768 as const;

export const EMBED_CONFIG = {
  endpoint: readEmbedEndpoint(),
  model: EMBED_MODEL_ID,
  version: EMBED_VERSION,
  dimension: EMBED_DIMENSION,
  maxTextsPerBatch: 32,
  maxCharsPerText: 8_000,
} as const;

export function isEmbedConfigured(): boolean {
  return Boolean(EMBED_CONFIG.endpoint && EMBED_CONFIG.endpoint.startsWith('http'));
}
