# Embed worker (Phase 3 hardened)

Browser sends **Firebase ID token** only. **GEMINI_API_KEY** is a Worker secret.

## Security (production)

| Control | Status |
|---------|--------|
| API key server-side only | required |
| Firebase JWT **signature** via Google JWKS | required |
| `FIREBASE_PROJECT_ID` mandatory (fail closed) | required |
| CORS exact Pages origin | `ALLOWED_ORIGIN` |
| Per-uid rate limit | `RATE_LIMIT_PER_MIN` (default 30/min) |
| Upstream retry 429/5xx | 3 attempts, exponential backoff |
| Strict text validation | string-only, non-empty, max length |
| Response dimension check | must match `EMBED_DIMENSION` |
| Model id aligned with SPA | `gemini-embedding-2` |

## Deploy

```bash
cd workers/embed
cp wrangler.toml.example wrangler.toml
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put FIREBASE_PROJECT_ID
npx wrangler deploy
```

SPA:

```bash
VITE_EMBED_ENDPOINT=https://drive-semantic-embed.<subdomain>.workers.dev
```

## Not yet (Phase 3b / 4)

- IndexedDB vector store
- Cosine search wiring
- Durable Object rate limits (cross-isolate)
