/**
 * Authenticated /embed proxy — Phase 3 hardened.
 * Secrets: GEMINI_API_KEY, FIREBASE_PROJECT_ID (required)
 * Vars: EMBED_MODEL=gemini-embedding-2, EMBED_DIMENSION=768, ALLOWED_ORIGIN, …
 */

export interface Env {
  GEMINI_API_KEY: string;
  FIREBASE_PROJECT_ID: string;
  EMBED_MODEL?: string;
  EMBED_DIMENSION?: string;
  MAX_TEXTS?: string;
  MAX_CHARS?: string;
  MAX_BODY_BYTES?: string;
  ALLOWED_ORIGIN?: string;
  RATE_LIMIT_PER_MIN?: string;
}

const DEFAULT_MODEL = 'gemini-embedding-2';
const DEFAULT_DIMENSION = 768;
const DEFAULT_ORIGIN = 'https://awasthisach.github.io';
const JWKS_URL =
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

let jwksCache: { keys: (JsonWebKey & { kid?: string })[]; fetchedAt: number } | null = null;
const JWKS_TTL_MS = 60 * 60 * 1000;

/** Per-isolate rate buckets (best-effort on CF Workers). */
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

function corsHeaders(origin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    Vary: 'Origin',
  };
}

function json(data: unknown, status: number, origin: string): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

function b64urlToBytes(s: string): Uint8Array {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function resolveOrigin(request: Request, allowed: string): string | null {
  const reqOrigin = request.headers.get('Origin');
  if (!reqOrigin) return allowed;
  if (reqOrigin === allowed) return allowed;
  return null;
}

function checkRateLimit(key: string, limit: number): boolean {
  const now = Date.now();
  let b = rateBuckets.get(key);
  if (!b || now >= b.resetAt) {
    b = { count: 0, resetAt: now + 60_000 };
    rateBuckets.set(key, b);
  }
  b.count += 1;
  return b.count <= limit;
}

async function getJwk(kid: string): Promise<JsonWebKey | null> {
  const now = Date.now();
  if (!jwksCache || now - jwksCache.fetchedAt > JWKS_TTL_MS) {
    const res = await fetch(JWKS_URL);
    if (!res.ok) return null;
    const body = (await res.json()) as { keys?: (JsonWebKey & { kid?: string })[] };
    jwksCache = { keys: body.keys || [], fetchedAt: now };
  }
  return jwksCache.keys.find(k => k.kid === kid) || null;
}

async function verifyFirebaseIdToken(
  token: string,
  projectId: string
): Promise<{ ok: true; sub: string } | { ok: false; reason: string }> {
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };

  let header: { alg?: string; kid?: string };
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[0])));
    payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1])));
  } catch {
    return { ok: false, reason: 'decode' };
  }

  if (header.alg !== 'RS256' || !header.kid) return { ok: false, reason: 'alg' };

  const expectedIss = 'https://securetoken.google.com/' + projectId;
  if (payload.aud !== projectId) return { ok: false, reason: 'aud' };
  if (payload.iss !== expectedIss) return { ok: false, reason: 'iss' };
  const sub = String(payload.sub || '');
  if (!sub) return { ok: false, reason: 'sub' };
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp < now) return { ok: false, reason: 'exp' };
  if (typeof payload.iat !== 'number' || payload.iat > now + 60) return { ok: false, reason: 'iat' };

  const jwk = await getJwk(header.kid);
  if (!jwk) return { ok: false, reason: 'jwks' };

  try {
    const key = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify']
    );
    const data = new TextEncoder().encode(parts[0] + '.' + parts[1]);
    const sig = b64urlToBytes(parts[2]);
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, data);
    if (!ok) return { ok: false, reason: 'sig' };
  } catch {
    return { ok: false, reason: 'verify' };
  }

  return { ok: true, sub };
}

async function callGeminiEmbed(
  env: Env,
  model: string,
  dimension: number,
  texts: string[],
  mode: 'query' | 'document',
  contractVersion: '2' | '3'
): Promise<{ ok: true; embeddings: number[][] } | { ok: false; status: number }> {
  const url =
    'https://generativelanguage.googleapis.com/v1beta/models/' +
    encodeURIComponent(model) +
    ':batchEmbedContents';

  const requests = texts.map(text => ({
    model: 'models/' + model,
    content: {
      parts: [{
        text:
          mode === 'query'
            ? 'task: search result | query: ' + text
            : contractVersion === '2'
              ? 'title: none | text: ' + text
              : text,
      }],
    },
    outputDimensionality: dimension,
  }));

  const maxAttempts = 3;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const geminiRes = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': env.GEMINI_API_KEY,
      },
      body: JSON.stringify({ requests }),
    });
    if (geminiRes.ok) {
      const geminiJson = (await geminiRes.json()) as {
        embeddings?: { values?: number[] }[];
      };
      const embeddings = (geminiJson.embeddings || []).map(e => e.values || []);
      return { ok: true, embeddings };
    }
    const status = geminiRes.status;
    const retryable = status === 429 || status === 500 || status === 502 || status === 503;
    if (!retryable || attempt === maxAttempts - 1) {
      return { ok: false, status };
    }
    const delay = 200 * Math.pow(2, attempt) + Math.floor(Math.random() * 100);
    await new Promise(r => setTimeout(r, delay));
  }
  return { ok: false, status: 502 };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const allowedOrigin = (env.ALLOWED_ORIGIN || DEFAULT_ORIGIN).replace(/\/$/, '');
    const originOk = resolveOrigin(request, allowedOrigin);
    const corsOrigin = originOk || allowedOrigin;

    if (request.method === 'OPTIONS') {
      if (!originOk && request.headers.get('Origin')) {
        return new Response(null, { status: 403 });
      }
      return new Response(null, { status: 204, headers: corsHeaders(corsOrigin) });
    }

    if (request.method === 'GET' && new URL(request.url).pathname === '/') {
      return json({ ok: true, model: env.EMBED_MODEL || DEFAULT_MODEL, version: '3', dimension: Number(env.EMBED_DIMENSION || DEFAULT_DIMENSION) }, 200, corsOrigin);
    }

    if (request.method !== 'POST') {
      return json({ error: 'POST only' }, 405, corsOrigin);
    }

    if (request.headers.get('Origin') && !originOk) {
      return json({ error: 'origin not allowed' }, 403, allowedOrigin);
    }

    if (!env.FIREBASE_PROJECT_ID || !String(env.FIREBASE_PROJECT_ID).trim()) {
      return json({ error: 'server misconfigured (FIREBASE_PROJECT_ID)' }, 500, corsOrigin);
    }
    if (!env.GEMINI_API_KEY) {
      return json({ error: 'server misconfigured (GEMINI_API_KEY)' }, 500, corsOrigin);
    }

    const maxBodyBytes = Number(env.MAX_BODY_BYTES || 300_000);
    const contentLength = Number(request.headers.get('Content-Length') || 0);
    if (contentLength > maxBodyBytes) {
      return json({ error: 'request too large' }, 413, corsOrigin);
    }

    const auth = request.headers.get('Authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    const verified = await verifyFirebaseIdToken(token, env.FIREBASE_PROJECT_ID);
    if (!verified.ok) {
      return json({ error: 'unauthorized', detail: verified.reason }, 401, corsOrigin);
    }

    const rateLimit = Number(env.RATE_LIMIT_PER_MIN || 30);
    if (!checkRateLimit(verified.sub, rateLimit)) {
      return json({ error: 'rate limited' }, 429, corsOrigin);
    }

    let body: unknown;
    try {
      const bodyText = await request.text();
      if (new TextEncoder().encode(bodyText).byteLength > maxBodyBytes) {
        return json({ error: 'request too large' }, 413, corsOrigin);
      }
      body = JSON.parse(bodyText);
    } catch {
      return json({ error: 'invalid json' }, 400, corsOrigin);
    }

    if (!body || typeof body !== 'object') {
      return json({ error: 'invalid body' }, 400, corsOrigin);
    }
    const textsRaw = (body as { texts?: unknown }).texts;
    const modeRaw = (body as { mode?: unknown }).mode;
    const versionRaw = (body as { version?: unknown }).version;
    if (!Array.isArray(textsRaw) || !textsRaw.length) {
      return json({ error: 'texts required' }, 400, corsOrigin);
    }

    const maxTexts = Number(env.MAX_TEXTS || 32);
    const maxChars = Number(env.MAX_CHARS || 8000);
    if (textsRaw.length > maxTexts) {
      return json({ error: 'batch too large' }, 400, corsOrigin);
    }

    const texts: string[] = [];
    for (const item of textsRaw) {
      if (typeof item !== 'string') {
        return json({ error: 'each text must be a string' }, 400, corsOrigin);
      }
      const t = item.trim();
      if (!t) {
        return json({ error: 'empty text not allowed' }, 400, corsOrigin);
      }
      if (t.length > maxChars) {
        return json({ error: 'text too long' }, 400, corsOrigin);
      }
      texts.push(t);
    }

    const model = env.EMBED_MODEL || DEFAULT_MODEL;
    const dimension = Number(env.EMBED_DIMENSION || DEFAULT_DIMENSION);
    let mode: 'query' | 'document';
    if (modeRaw === 'query') {
      mode = 'query';
    } else if (modeRaw === undefined || modeRaw === null || modeRaw === '' || modeRaw === 'document') {
      mode = 'document';
    } else {
      return json({ error: 'invalid mode' }, 400, corsOrigin);
    }

    // No version means a legacy v2 client. During rollout, serve both contracts.
    const responseVersion = versionRaw === undefined ? '2' : String(versionRaw);
    if (responseVersion !== '2' && responseVersion !== '3') {
      return json({ error: 'unsupported contract version' }, 400, corsOrigin);
    }

    const result = await callGeminiEmbed(env, model, dimension, texts, mode, responseVersion);
    if (!result.ok) {
      return json({ error: 'upstream embed failed', status: result.status }, 502, corsOrigin);
    }

    if (result.embeddings.length !== texts.length) {
      return json({ error: 'upstream length mismatch' }, 502, corsOrigin);
    }
    for (const row of result.embeddings) {
      if (!row || row.length !== dimension || row.some(value => !Number.isFinite(value))) {
        return json({ error: 'upstream dimension mismatch' }, 502, corsOrigin);
      }
    }

    return json(
      {
        embeddings: result.embeddings,
        model,
        version: responseVersion,
        dimension,
      },
      200,
      corsOrigin
    );
  },
};
