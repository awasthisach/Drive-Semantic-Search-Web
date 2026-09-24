const endpoint = (process.env.EMBED_ENDPOINT || '').replace(/\/$/, '');
const token = process.env.FIREBASE_TEST_ID_TOKEN || '';

if (!endpoint || !/^https:\/\//.test(endpoint)) {
  throw new Error('EMBED_ENDPOINT must be an HTTPS URL');
}
if (!token) {
  throw new Error('FIREBASE_TEST_ID_TOKEN GitHub secret is required for the live contract gate');
}

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
