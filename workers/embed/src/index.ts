/**
 * Authenticated /embed proxy for Gemini embeddings.
 * Deploy: Cloudflare Worker (see wrangler.toml.example).
 * Secrets: GEMINI_API_KEY, FIREBASE_PROJECT_ID
 *
 * Request:  POST /  Authorization: Bearer <Firebase ID token>
 * Body:     { "texts": string[], "taskType"?: "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY" }
 * Response: { embeddings, model, version, dimension }
 *
 * Never logs document text.
 */

export interface Env {
  GEMINI_API_KEY: string;
  FIREBASE_PROJECT_ID?: string;
  EMBED_MODEL?: string;
  EMBED_DIMENSION?: string;
  MAX_TEXTS?: string;
  MAX_CHARS?: string;
}

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

function parseJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const jsonStr = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(jsonStr);
  } catch {
    return null;
  }
}

async function verifyFirebaseIdToken(
  token: string,
  projectId: string | undefined
): Promise<{ ok: boolean; reason?: string }> {
  if (!token || token.length < 20) return { ok: false, reason: 'missing token' };
  const payload = parseJwtPayload(token);
  if (!payload) return { ok: false, reason: 'malformed token' };
  if (projectId) {
    const aud = String(payload.aud || '');
    const iss = String(payload.iss || '');
    if (aud !== projectId && !iss.includes(projectId)) {
      return { ok: false, reason: 'audience mismatch' };
    }
  }
  const exp = Number(payload.exp || 0);
  if (exp && exp * 1000 < Date.now()) return { ok: false, reason: 'expired' };
  // Production: verify signature via Google certs (jwks). Scaffold checks shape + exp + aud.
  return { ok: true };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (request.method !== 'POST') {
      return json({ error: 'POST only' }, 405);
    }

    const auth = request.headers.get('Authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    const verified = await verifyFirebaseIdToken(token, env.FIREBASE_PROJECT_ID);
    if (!verified.ok) {
      return json({ error: 'unauthorized', detail: verified.reason }, 401);
    }

    if (!env.GEMINI_API_KEY) {
      return json({ error: 'server misconfigured' }, 500);
    }

    let body: { texts?: string[]; taskType?: string };
    try {
      body = await request.json();
    } catch {
      return json({ error: 'invalid json' }, 400);
    }

    const maxTexts = Number(env.MAX_TEXTS || 32);
    const maxChars = Number(env.MAX_CHARS || 8000);
    const texts = Array.isArray(body.texts) ? body.texts : [];
    if (!texts.length) return json({ error: 'texts required' }, 400);
    if (texts.length > maxTexts) return json({ error: 'batch too large' }, 400);

    const cleaned = texts.map(t => String(t || '').slice(0, maxChars));
    const model = env.EMBED_MODEL || 'text-embedding-004';
    const dimension = Number(env.EMBED_DIMENSION || 768);
    const taskType =
      body.taskType === 'RETRIEVAL_QUERY' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT';

    const url =
      'https://generativelanguage.googleapis.com/v1beta/models/' +
      encodeURIComponent(model) +
      ':batchEmbedContents?key=' +
      encodeURIComponent(env.GEMINI_API_KEY);

    const requests = cleaned.map(text => ({
      model: 'models/' + model,
      content: { parts: [{ text }] },
      taskType,
      outputDimensionality: dimension,
    }));

    const geminiRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests }),
    });

    if (!geminiRes.ok) {
      return json({ error: 'upstream embed failed', status: geminiRes.status }, 502);
    }

    const geminiJson = (await geminiRes.json()) as {
      embeddings?: { values?: number[] }[];
    };
    const embeddings = (geminiJson.embeddings || []).map(e => e.values || []);
    if (embeddings.length !== cleaned.length) {
      return json({ error: 'upstream length mismatch' }, 502);
    }

    return json({
      embeddings,
      model,
      version: '1',
      dimension,
    });
  },
};
