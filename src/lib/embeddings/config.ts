/**
 * Public embed client config only.
 * Never put GEMINI_API_KEY (or any secret) in VITE_* vars or the SPA bundle.
 */
function readEmbedEndpoint(): string {
  try {
    const env = (import.meta as unknown as { env?: Record<string, string> }).env;
    return (env && env.VITE_EMBED_ENDPOINT) || '';
  } catch {
    return '';
  }
}

export const EMBED_CONFIG = {
  /** Serverless /embed URL (Cloudflare Worker, Cloud Function, etc.). */
  endpoint: readEmbedEndpoint(),
  /** Logical model id — backend may map this to a concrete Gemini model. */
  model: 'gemini-embedding-2',
  version: '1',
  /** Start with 768 for IDB size; verify relevance before raising. */
  dimension: 768,
  maxTextsPerBatch: 32,
  maxCharsPerText: 8_000,
} as const;

export function isEmbedConfigured(): boolean {
  return Boolean(EMBED_CONFIG.endpoint && EMBED_CONFIG.endpoint.startsWith('http'));
}
