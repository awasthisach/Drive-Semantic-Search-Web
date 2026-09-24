# Cloudflare Embed Worker

The Worker is the only component that can access `GEMINI_API_KEY`. The browser sends a Firebase ID token and a batch of text inputs to the authenticated `/embed` endpoint; it never receives the Gemini key.

## Current contract

The Worker calls **Gemini Embedding 2** with `outputDimensionality = 768`. Gemini’s obsolete `taskType` field is not sent. Instead, the Worker converts the browser’s internal `mode` into the documented retrieval instruction in the embedding input:

- Query: `task: search result | query: {query text}`
- Document: `{title-aware document chunk}` (for example, `title: report.pdf | text: ...`)

Successful responses contain `{ embeddings, model, version: "3", dimension: 768 }`. The SPA rejects mismatched model, version, dimension, or batch length responses. Version 3 is intentionally incompatible with older vectors because document chunks now include the filename; the browser re-embeds them before using them for neural ranking.

## Security controls

| Control | Implementation |
|---|---|
| Gemini API key | Cloudflare Worker secret, sent upstream in `x-goog-api-key`; never in the URL or SPA bundle |
| Firebase authentication | RS256 Firebase ID-token signature verification through Google JWKS, with issuer, audience, expiry, issued-at, and subject checks |
| Project isolation | `FIREBASE_PROJECT_ID` is required and checked against token claims |
| CORS | Exact `ALLOWED_ORIGIN`, normally `https://awasthisach.github.io` |
| Rate limiting | Best-effort per-user isolate bucket via `RATE_LIMIT_PER_MIN` |
| Input limits | Maximum text count, per-text characters, and request body bytes |
| Upstream resilience | Three attempts for 429 and transient 5xx responses with exponential backoff |
| Logging | No document text, Firebase token, or Gemini key is logged |

## Configuration

`wrangler.toml` contains non-secret deployment configuration only. Set `GEMINI_API_KEY` as a Worker secret. `FIREBASE_PROJECT_ID` may remain a Worker variable because it identifies the Firebase project, not a credential; it is still validated server-side.

```bash
cd workers/embed
npm ci
npx wrangler secret put GEMINI_API_KEY
npm run check
npm run deploy
```

The repository’s `.github/workflows/deploy-worker.yml` performs the dry run and deployment on changes under `workers/embed/**` or through manual dispatch. It requires the GitHub Actions secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`; values are never committed or printed.

## SPA integration

The production endpoint is:

```text
https://drive-semantic-embed.awasthi-sach.workers.dev
```

The Pages workflow injects `VITE_EMBED_ENDPOINT`, defaulting to that endpoint. The SPA’s CSP permits only this exact Worker origin. After changing the embedding model, retrieval instructions, dimension, or compatibility version, re-index extractable Drive content so all current vectors are regenerated.

## Limitations

The rate limiter is isolate-local rather than globally durable. Vector records are stored in browser IndexedDB and filtered by corpus key, model, version, dimension, content hash, and live Drive file IDs. Large corpora may eventually benefit from an ANN index or a server-side index; the current design avoids putting the full corpus in application state but does read the selected corpus’s vectors for ranking.
