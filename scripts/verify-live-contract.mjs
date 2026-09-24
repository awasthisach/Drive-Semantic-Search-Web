import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const endpoint = (process.env.EMBED_ENDPOINT || '').replace(/\/$/, '');

if (!endpoint || !/^https:\/\//.test(endpoint)) {
  throw new Error('EMBED_ENDPOINT must be an HTTPS URL');
}
async function getFirebaseIdToken() {
  if (process.env.FIREBASE_TEST_ID_TOKEN) return process.env.FIREBASE_TEST_ID_TOKEN;

  const email = process.env.FIREBASE_TEST_EMAIL || '';
  const password = process.env.FIREBASE_TEST_PASSWORD || '';
  if (!email || !password) {
    throw new Error('Set FIREBASE_TEST_ID_TOKEN or FIREBASE_TEST_EMAIL and FIREBASE_TEST_PASSWORD');
  }

  let apiKey = process.env.FIREBASE_API_KEY || '';
  if (!apiKey) {
    const configPath = resolve(dirname(fileURLToPath(import.meta.url)), '../firebase-applet-config.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    apiKey = config.apiKey || '';
  }
  if (!apiKey) throw new Error('Firebase public API key is missing');

  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Referer: 'https://awasthisach.github.io/Drive-Semantic-Search-Web/',
      },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    }
  );
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.idToken) {
    const code = body?.error?.message || `HTTP_${response.status}`;
    throw new Error(`Firebase test-user sign-in failed: ${code}`);
  }
  return body.idToken;
}

const token = await getFirebaseIdToken();

const expectedModel = 'gemini-embedding-2';
const expectedVersion = '3';
const expectedDimension = 768;

async function verify(mode, texts, version, expectedVersion = version) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ texts, mode, ...(version ? { version } : {}) }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`Live ${mode} embed contract returned HTTP ${response.status}`);
  if (!body || body.model !== expectedModel || body.version !== expectedVersion || body.dimension !== expectedDimension) {
    throw new Error(`Live ${mode} embed contract metadata mismatch`);
  }
  if (!Array.isArray(body.embeddings) || body.embeddings.length !== texts.length) {
    throw new Error(`Live ${mode} embed contract embedding count mismatch`);
  }
  for (const row of body.embeddings) {
    if (!Array.isArray(row) || row.length !== expectedDimension || row.some(value => !Number.isFinite(value))) {
      throw new Error(`Live ${mode} embed contract vector shape mismatch`);
    }
  }
}

await verify('query', ['cannabis'], '3');
await verify('document', ['title: Hemp Research.pdf | text: controlled contract probe'], '3');
await verify('query', ['legacy compatibility probe'], undefined, '2');
console.log(`Live embed contract passed: v3 query/document and legacy v2 compatibility; model=${expectedModel}, dimension=${expectedDimension}`);
