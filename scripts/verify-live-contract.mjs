import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const endpoint = (process.env.EMBED_ENDPOINT || '').replace(/\/$/, '');
if (!endpoint || !/^https:\/\//.test(endpoint)) throw new Error('EMBED_ENDPOINT must be an HTTPS URL');
const endpointUrl = new URL(endpoint);
const embedPath = endpointUrl.pathname === '/' ? '/embed' : endpointUrl.pathname;
const healthEndpoint = endpointUrl.origin + '/';

const expectedModel = 'gemini-embedding-2';
const expectedVersion = '3';
const expectedDimension = 768;

async function getFirebaseIdToken() {
  if (process.env.FIREBASE_TEST_ID_TOKEN) return process.env.FIREBASE_TEST_ID_TOKEN;
  const email = process.env.FIREBASE_TEST_EMAIL || '';
  const password = process.env.FIREBASE_TEST_PASSWORD || '';
  if (!email || !password) {
    throw new Error('Set FIREBASE_TEST_EMAIL and FIREBASE_TEST_PASSWORD (or FIREBASE_TEST_ID_TOKEN) for the authenticated live contract gate');
  }
  let apiKey = process.env.FIREBASE_API_KEY || '';
  if (!apiKey) {
    const configPath = resolve(dirname(fileURLToPath(import.meta.url)), '../firebase-applet-config.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    apiKey = config.apiKey || '';
  }
  if (!apiKey) throw new Error('Firebase public API key is missing');
  const response = await fetch(
    'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=' + encodeURIComponent(apiKey),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Referer: 'https://awasthisach.github.io/Drive-Semantic-Search-Web/' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    }
  );
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.idToken) {
    throw new Error('Firebase test-user sign-in failed: ' + (body?.error?.message || ('HTTP_' + response.status)));
  }
  return body.idToken;
}

const token = await getFirebaseIdToken();
const health = await fetch(healthEndpoint, { method: 'GET' });
const healthBody = await health.json().catch(() => null);
if (!health.ok || !healthBody || healthBody.model !== expectedModel || healthBody.version !== expectedVersion || healthBody.dimension !== expectedDimension) {
  throw new Error('Live Worker health/config contract failed (HTTP ' + health.status + ')');
}
const unauth = await fetch(healthEndpoint.replace(/\/$/, '') + embedPath, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ texts: ['unauthenticated contract probe'], mode: 'query', version: '3' }),
});
if (unauth.status !== 401) throw new Error('Live Worker auth gate expected HTTP 401, got ' + unauth.status);

async function verify(mode, texts, version, expectedResponseVersion = version) {
  const response = await fetch(healthEndpoint.replace(/\/$/, '') + embedPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ texts, mode, version }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body || body.model !== expectedModel || body.version !== expectedResponseVersion || body.dimension !== expectedDimension) {
    throw new Error('Authenticated ' + mode + ' embed contract failed (HTTP ' + response.status + ')');
  }
  if (!Array.isArray(body.embeddings) || body.embeddings.length !== texts.length) throw new Error('Authenticated ' + mode + ' embedding count mismatch');
  for (const row of body.embeddings) {
    if (!Array.isArray(row) || row.length !== expectedDimension || row.some(value => !Number.isFinite(value))) {
      throw new Error('Authenticated ' + mode + ' embedding vector shape mismatch');
    }
  }
}
await verify('query', ['cannabis'], '3');
await verify('document', ['title: Hemp Research.pdf | text: controlled contract probe'], '3');
await verify('query', ['legacy compatibility probe'], '2', '2');
console.log('Live Worker contract passed: health/config, auth gate, v3 query/document, and legacy v2 compatibility');
