const endpoint = (process.env.EMBED_ENDPOINT || '').replace(/\/$/, '');
if (!endpoint || !/^https:\/\//.test(endpoint)) throw new Error('EMBED_ENDPOINT must be an HTTPS URL');
const endpointUrl = new URL(endpoint);
const embedPath = endpointUrl.pathname === '/' ? '/embed' : endpointUrl.pathname;
const healthEndpoint = endpointUrl.origin + '/';

const expectedModel = 'gemini-embedding-2';
const expectedVersion = '3';
const expectedDimension = 768;

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
const token = process.env.FIREBASE_TEST_ID_TOKEN || '';
if (token) {
  const authenticated = await fetch(healthEndpoint.replace(/\/$/, '') + embedPath, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ texts: ['authenticated contract probe'], mode: 'query', version: '3' }),
  });
  const body = await authenticated.json().catch(() => null);
  if (!authenticated.ok || !body || body.model !== expectedModel || body.version !== expectedVersion || body.dimension !== expectedDimension || !Array.isArray(body.embeddings) || body.embeddings.length !== 1 || !Array.isArray(body.embeddings[0]) || body.embeddings[0].length !== expectedDimension || body.embeddings[0].some(v => !Number.isFinite(v))) throw new Error('Authenticated live embedding contract failed (HTTP ' + authenticated.status + ')');
  console.log('Live Worker contract passed: health/config, auth gate, and authenticated embedding');
} else {
  console.log('Live Worker contract passed: health/config and unauthenticated auth gate; authenticated probe skipped (no FIREBASE_TEST_ID_TOKEN)');
}
