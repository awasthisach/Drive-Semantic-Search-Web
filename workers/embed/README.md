# Cloudflare Embed Worker

The Worker is the only component that can access `GEMINI_API_KEY`. The browser sends a Firebase ID token and a batch of text inputs to the authenticated `/embed` endpoint; it never receives the Gemini key.

## Current contract

The Worker calls **Gemini Embedding 2** with `outputDimensionality = 768`. Gemini's obsolete `taskType` field is not sent. Instead, the Worker converts the browser's internal `mode` into the documented retrieval instruction in the embedding input:

- Query: `task: search result | query: {query text}`
- Document: `{title-aware document chunk}` (for example, `title: report.pdf | text: ...`)

Successful v3 responses contain `{ embeddings, model, version: "3", dimension: 768 }`. The request carries `version: "3"`; legacy clients that omit `version` receive a v2 response during the rollout window. The SPA rejects mismatched model, version, dimension, or batch length responses. Version 3 is intentionally incompatible with older vectors because document chunks now include the filename; the browser re-embeds them before using them for neural ranking. This negotiation makes Worker-first deployment safe for the still-live v2 SPA.

## Security controls

| Control | Implementation |
|---|---|
| Gemini API key | Cloudflare Worker secret, sent upstream in `x-goog-api-key`; never in the URL or SPA bundle |
| Firebase authentication | RS256 Firebase ID-token signature verification through Google JWKS, with issuer, audience, expiry, issued-at, and subject checks |
| Project isolation | `FIREBASE_PROJECT_ID` is required and checked against token claims |
| CORS | Exact `ALLOWED_ORIGIN`, normally `https://awasthisach.github.io` |
| Rate limiting | Durable Object fixed 60-second bucket, keyed by verified Firebase subject; default 30 requests/minute |
| Input limits | Maximum text count, per-text characters, and request body bytes |
| Upstream resilience | Three attempts for 429 and transient 5xx responses with exponential backoff |
| Logging | No document text, Firebase token, Gemini key, or raw user identifier is logged |

## Observability

`wrangler.toml` enables Cloudflare Workers Observability with full request sampling. This makes invocation logs available in Workers Logs and the dashboard metrics available for the Worker and its Durable Object namespace. Full sampling captures every invocation; lower `head_sampling_rate` if traffic or log volume grows.

The rate limiter emits one structured `rate_limit_window_exceeded` warning for a user bucket the first time it crosses the limit during a 60-second window. The event includes the bucket count, configured limit, and retry delay, but no user ID, request body, or token. Repeated rejected calls in the same window do not emit duplicate custom warnings. The event count therefore represents throttled user-windows, not every individual 429. Durable Object metrics provide aggregate request/CPU/storage measurements.

### Live log tail

With Cloudflare credentials authorized for this account, run from this directory:

```bash
npx wrangler tail drive-semantic-embed
```

For structured output that can be filtered with `jq`:

```bash
npx wrangler tail drive-semantic-embed --format json
```

`wrangler tail` is a live stream; it does not provide historical logs.

### Dashboard

1. Open [Workers & Pages](https://dash.cloudflare.com/?to=/:account/workers-and-pages) and select `drive-semantic-embed`.
2. Open **Logs** → **Live** for real-time events, or **Observability** for stored logs.
3. Open the [Durable Objects dashboard](https://dash.cloudflare.com/?to=/:account/workers/durable-objects), select the `RATE_LIMITER` namespace, and view **Metrics** for aggregate requests, CPU, memory, and storage.

Cloudflare documents a maximum Workers Logs retention period of seven days. The rate limiter's exact bucket state remains in Durable Object storage and is not exposed as a per-user dashboard metric; custom logs record only when a bucket first exceeds its limit in a window.

## Configuration

`wrangler.toml` contains non-secret deployment configuration only. Set `GEMINI_API_KEY` as a Worker secret. `FIREBASE_PROJECT_ID` may remain a Worker variable because it identifies the Firebase project, not a credential; it is still validated server-side.

```bash
cd workers/embed
npm ci
npx wrangler secret put GEMINI_API_KEY
npm run check
npm run deploy
```

The main deployment workflow performs the Worker dry run, deploys the Worker, and runs an authenticated live contract check before GitHub Pages deployment. It requires the GitHub Actions secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and `FIREBASE_TEST_ID_TOKEN`; values are never committed or printed. The separate `.github/workflows/deploy-worker.yml` is manual-only to prevent a second automatic Worker deployment racing the ordered main workflow.

## SPA integration

The production endpoint is:

```text
https://drive-semantic-embed.awasthi-sach.workers.dev
```

The Pages workflow injects `VITE_EMBED_ENDPOINT`, defaulting to that endpoint. The SPA's CSP permits only this exact Worker origin. Production rollout is intentionally ordered as Worker deploy → authenticated contract verification → Pages deploy. After changing the embedding model, retrieval instructions, dimension, or compatibility version, re-index extractable Drive content so all current vectors are regenerated.

## Limitations

Vector records are stored in browser IndexedDB and filtered by corpus key, model, version, dimension, content hash, and live Drive file IDs. Large corpora may eventually benefit from an ANN index or a server-side index; the current design avoids putting the full corpus in application state but does read the selected corpus's vectors for ranking.
