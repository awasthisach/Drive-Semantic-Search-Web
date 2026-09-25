# Drive Semantic Search

Client-side web app for Google Drive: sync, **hybrid search** (neural cosine + BM25 + metadata), offline pin, encrypted vault, and SHA-256 duplicate verification.

**Live:** https://awasthisach.github.io/Drive-Semantic-Search-Web/

**Embed Worker:** https://drive-semantic-embed.awasthi-sach.workers.dev

**HEAD notes:** Search uses neural retrieval when the Worker is reachable and vectors are indexed. If the Worker is down, search falls back to **BM25 + metadata**.

---

## Features

- **Google Drive** — OAuth (GIS/Firebase), My Drive / All drives / Shared Drive, type filters, upload, trash, move, folders, star
- **Token lifecycle** — expiry, silent refresh, revoke on sign-out; `withDriveAuthRetry` on mutations
- **Incremental sync** — Drive Changes API; full list seeds page token; delta Sync Now when type filter = all
- **Hybrid search**
  - **Metadata** — filename, summary, tags (exact name boost)
  - **BM25 body** — IndexedDB postings over extracted Drive text
  - **Neural (optional)** — Gemini Embedding 2 (768 dimensions, compatibility version 3) via authenticated Worker → cosine over chunk vectors → hybrid blend
  - Highlight chips, match reasons, Star / Pin offline / Copy link on results
  - Hindi/Hinglish query expansion (lightweight pairs; preserves Devanagari combining marks)
- **Content + vector index** — IndexedDB BM25 docs/chunks/postings **and** separate vector store; content-hash skip re-embed; cancel + progress; **resume cursor** (SHA-256 signature of corpus file list)
- **Select all visible** — pagination-aware (current page only)
- **Offline pin** — IndexedDB LRU + SHA-256; browser storage quota on Offline tab
- **Vault** — PBKDF2 310k + AES-GCM (Worker + main-thread fallback)
- **Duplicates** — size+name candidates; trash locked until SHA-256 verify; durable hash snapshot
- **Local diagnostics** — ring buffer; header **Diagnostics** export (tokens redacted)
- **PWA** — Vite PWA shell, installable

---

## Stack

React 19 · Vite 6 · Tailwind 4 · TypeScript strict · Firebase Auth + GIS · Drive API v3 · IndexedDB · Web Crypto · Vitest 5 · optional Cloudflare Worker (`workers/embed`)

---

## Scripts

```bash
npm ci
npm run dev      # localhost:3000
npm run lint     # tsc --noEmit
npm test
npm run build
npm run check:bundle
```

**CI:** `npm ci` → lint → placeholder guard → audit → test → build → bundle budget → GitHub Pages (push to `main`).

### Local pre-push (optional)

```bash
git config core.hooksPath .githooks
```

Runs `lint` + `test` + `build` before every push. Prefer branch protection requiring the Deploy workflow on `main`.

---

## Search architecture

```
Google Drive
     |
     v
Incremental extract / index
     |
     +--------------+--------------+
     v              v              v
 Metadata      BM25 index     Vector index (768-d)
     |              |              |
     +--------------+--------------+
                    v
              Hybrid ranking
     (provisional weights — see below)
```

| Signal | When active |
|--------|-------------|
| Metadata | Always |
| BM25 body | After “Index extractable content” |
| Neural cosine | Worker reachable **and** vectors stored during index |

**Provisional hybrid weights** (code: `HYBRID_WEIGHTS` in `src/lib/searchEngine.ts`):

| Component | Weight |
|-----------|--------|
| Neural | 0.55 |
| BM25 | 0.25 |
| Metadata | 0.20 |

These are **not** eval-validated on a real Drive/Gemini corpus. Tune after live ranking inspection.

If the embed pipeline fails or is not configured, search **falls back** to BM25 + metadata (does not hard-fail).

---

## Enable neural search (ops)

Production Worker URL (public, not a secret):

`https://drive-semantic-embed.awasthi-sach.workers.dev`

The SPA defaults to this URL. CI uses repository secret `VITE_EMBED_ENDPOINT` when set, otherwise the same default. `VITE_EMBED_ENDPOINT` is public configuration, not a credential.

Worker must run **`workers/embed/src/index.ts`** (JSON `{ embeddings, model, version, dimension }`, with version `3`). A dashboard stub that returns plain `Unauthorized` will not work. Worker deployment is controlled by `.github/workflows/deploy-worker.yml` and requires `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` GitHub secrets.

Required Worker secrets/vars:

- Secret `GEMINI_API_KEY`
- Variable or secret `FIREBASE_PROJECT_ID=thevvforg`
- CORS origin default: `https://awasthisach.github.io`
- Model `gemini-embedding-2`, dimension `768`, embedding compatibility version `3`

After Worker + Pages are aligned:

1. Sign in on the live app
2. **Index extractable content** (writes BM25 + vectors)
3. Query cross-language cases (e.g. `बेरोजगारी` vs English “employment / joblessness” docs)
4. Confirm exact filename still ranks; embed downtime still returns BM25 results

**Live multilingual proof cannot be claimed from unit tests alone.**

### Secrets and deployment checklist

The web app itself does **not** require a secret in `.env`: `VITE_EMBED_ENDPOINT` is a public Worker URL, and every `VITE_*` value is bundled into the browser. Do not put a Gemini key, Cloudflare token, Firebase private key, or OAuth client secret there.

1. Create or select a Gemini API key in [Google AI Studio](https://aistudio.google.com/app/apikey). Keep the key server-side only.
2. In [Cloudflare Workers & Pages](https://dash.cloudflare.com/?to=/:account/workers), open the `drive-semantic-embed` Worker → **Settings** → **Variables and Secrets** → **Add** → **Encrypt**, and set `GEMINI_API_KEY` to that key. Set `FIREBASE_PROJECT_ID` to the Firebase project ID as a plain Worker variable.
3. For CI deployment, open the repository’s [GitHub Actions secrets page](https://github.com/awasthisach/Drive-Semantic-Search-Web/settings/secrets/actions) and add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. Add `FIREBASE_TEST_EMAIL` and `FIREBASE_TEST_PASSWORD` for the authenticated Worker contract gate. Create a dedicated low-privilege Firebase test user; these are CI-only credentials.
4. Keep `ALLOWED_ORIGIN` equal to the deployed Pages origin (default: `https://awasthisach.github.io`). If you deploy under a different domain, update this Worker variable before deploying the SPA.
5. Deploy the Worker first (`cd workers/embed && npm ci && npm run check && npm run deploy`), then deploy the SPA. Sign in, index extractable content, and run a search to verify the authenticated embed path.

Google Drive OAuth uses the public client configuration in `firebase-applet-config.json`; configure its authorized JavaScript origins and redirect domains in the [Google Cloud Credentials console](https://console.cloud.google.com/apis/credentials) and Firebase Authentication console. These client IDs are intentionally public and are not repository secrets.

---

## Honest limits

- Hybrid weights are **provisional** until eval on real Gemini embeddings
- Vector search loads corpus vectors from IndexedDB (`getAll`) — fine for small/medium corpora; large Drive may need later indexing/ANN work
- No full PDF/DOCX/OCR pipeline in browser yet (text extraction where Drive/export supports it)
- Filtered type syncs use full list; incremental only for type = **all**
- Broad `drive` OAuth scope; access token in `sessionStorage` (see [SECURITY.md](SECURITY.md))
- List pagination capped (~20k) with truncation banner
- Missing size → **Size unknown** (never invented)

---

## Resilience

- `fetchWithBackoff` on Drive list + mutations (429/403, Retry-After, jitter)
- Offline pin cancellable via `AbortController`
- Content-index prune is corpus-scoped and skipped when list is truncated
- Race-free durable meta + hash snapshot persist
- Embed API failure keeps prior valid vectors; search falls back without neural
- Version-1 and version-2 vectors are incompatible and are migrated only after successful version-3 re-embedding

---

## Security

- **Never** put `GEMINI_API_KEY` in `VITE_*` or the SPA bundle
- Browser sends Firebase **ID token** only to the Worker
- See [SECURITY.md](SECURITY.md). Report vulnerabilities via private GitHub advisory.
