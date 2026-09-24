const endpoint = (process.env.EMBED_ENDPOINT || '').replace(/\/$/, '');

if (!endpoint || !/^https:\/\//.test(endpoint)) throw new Error('EMBED_ENDPOINT must be an HTTPS URL');

const expectedModel = 'gemini-embedding-2';
const expectedVersion = '3';
const expectedDimension = 768;

const health = await fetch(endpoint, { method: 'GET' });
const healthBody = await health.json().catch(() => null);
if (!health.ok || !healthBody || healthBody.model !== expectedModel || healthBody.version !== expectedVersion || healthBody.dimension !== expectedDimension) {
  throw new Error('Live Worker health/config contract failed (HTTP ' + health.status + ')');
}

const unauth = await fetch(endpoint + '/embed', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ texts: ['unauthenticated contract probe'], mode: 'query', version: '3' }),
});
if (unauth.status !== 401) throw new Error('Live Worker auth gate expected HTTP 401, got ' + unauth.status);
console.log('Live Worker contract passed: health/config and unauthenticated /embed rejection; model=' + expectedModel + ', dimension=' + expectedDimension);
