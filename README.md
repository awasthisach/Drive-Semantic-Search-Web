# Drive Semantic Search

Client-side Progressive Web App for Google Drive with **hybrid semantic search** (neural vector similarity + BM25 + metadata), offline pinning, encrypted vault, duplicate verification, and Drive management features.

**Live:** https://awasthisach.github.io/Drive-Semantic-Search-Web/

**Embed Worker:** https://drive-semantic-embed.awasthi-sach.workers.dev

**Runtime rule:** Neural retrieval is used only when the authenticated embedding Worker is reachable and compatible vectors are indexed. Large corpora use ANN candidates followed by exact cosine reranking; if ANN returns no qualified hit, the search automatically performs an exact corpus scan before returning no neural result. If embeddings are unavailable, search remains usable through **BM25 + metadata** fallback.

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
- **Content + vector index** — IndexedDB BM25 docs/chunks/postings **and** separate vector store; versioned multi-probe LSH bucket index for large-corpus candidate retrieval; content-hash skip re-embed; cancel + progress; **resume cursor** (SHA-256 signature of corpus file list); idle ANN warm-up with Web Locks coordination across tabs
- **Select all visible** — pagination-aware (current page only)
- **Offline pin** — IndexedDB LRU + SHA-256; browser storage quota on offline tab
- **Vault** — PBKDF2 310k + AES-GCM (Worker + main-thread fallback)
- **Duplicates** — select duplicate/candidate files individually or in bulk; move selected files to Drive root or any folder; trash remains locked until SHA-256 verify; durable hash snapshot
- **Semantic duplicate review** — after content embedding, compare file-level embedding centroids with a user-selected similarity threshold (85/90/95%); semantic matches are review-only and can be selected for move, never auto-trashed
- **Local diagnostics** — privacy-preserving ring buffer with ANN candidate/fallback/latency metrics; header **Diagnostics** export (tokens and emails redacted)
- **PWA** — Vite PWA shell, installable

---

## Stack

React 19 · Vite 6 · Tailwind 4 · TypeScript strict · Firebase Auth + GIS · Drive API v3 · IndexedDB · Web Crypto · Vitest 5 · optional Cloudflare Worker (`workers/embed`)

---

## Quick setup instructions

### Normal development checkout

1. Install a current Node.js LTS release.
2. Clone the repository and enter it.
3. Run `npm ci`.
4. Run `npm run dev` for local development.
5. Before submitting changes, run `npm run lint`, `npm test`, and `npm run build`.

### Production neural-search setup

1. Deploy the Worker from `workers/embed`.
2. Configure the Worker secret `GEMINI_API_KEY` and variable `FIREBASE_PROJECT_ID`.
3. Keep `ALLOWED_ORIGIN` equal to the actual Pages origin.
4. Deploy the SPA only after the Worker endpoint is reachable and authenticated requests return the expected embedding response.
5. Sign in to the live app and run **Index extractable content** before testing neural search.
6. Test both a semantic query and a normal filename/keyword query.
7. Verify that an embedding failure still returns BM25 + metadata results.
8. Open **Duplicates**, select one or more files, choose **Move selected**, and confirm a Drive folder.
9. For semantic duplicate review, index extractable content first, then choose a similarity threshold and select **Find similar files**. Review the groups before moving anything.

**Security rule:** every `VITE_*` value is public because it is bundled into the browser. Never put `GEMINI_API_KEY`, Cloudflare API tokens, Firebase private keys, service-account credentials, or OAuth client secrets in frontend environment variables or committed files.

**Verification rule:** a green GitHub Actions build proves the code/build pipeline passed; it does **not** by itself prove that Google OAuth, Drive access, the Cloudflare Worker, or live neural retrieval works. Those must be runtime-tested.

---
## Scripts

```bash
npm ci
npm run dev      # localhost:3000
npm run lint     # tsc --noEmit
npm test
npm run evaluate:relevance  # deterministic ANN retrieval/relevance regression fixture
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
| Neural cosine | Worker reachable **and** vectors stored during index; exact scan for ≤128 vectors, IndexedDB LSH candidates above that, exact fallback when ANN has no qualified hit |

**Provisional hybrid weights** (code: `HYBRID_WEIGHTS` in `src/lib/searchEngine.ts`):

| Component | Weight |
|-----------|--------|
| Neural | 0.55 |
| BM25 | 0.25 |
| Metadata | 0.20 |

These are **not** eval-validated on a representative real Drive/Gemini corpus. Treat them as provisional until live ranking evaluation is performed.

If the embed pipeline fails or is not configured, search **falls back** to BM25 + metadata (does not hard-fail). If a stale PWA deployment references a removed lazy chunk, the app performs at most one guarded reload per minute to recover the current asset manifest.

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
- Large-corpus vector search uses a versioned IndexedDB multi-probe LSH index and exact cosine re-ranking of candidates; first use backfills the derived index with a streaming cursor. If the ANN candidate set is empty or produces no qualified hit, an exact corpus scan is used as a correctness fallback.
- ANN relevance is regression-tested on a deterministic, labeled fixture, not on real user Drive data; do not interpret the fixture as proof of production semantic quality or use it to tune hybrid weights
- No full PDF/DOCX/OCR pipeline in browser yet (text extraction where Drive/export supports it)
- Semantic duplicate groups use the centroid of indexed chunk embeddings. They are similarity candidates, not proof of byte-identical files; exact duplicate trash requires SHA-256 verification.
- Filtered type syncs use full list; incremental only for type = **all**
- Broad `drive` OAuth scope; access token in `sessionStorage` (see [SECURITY.md](SECURITY.md))
- Progressive chunked listing (pageSize 500) with live UI updates; safety ceiling only (~5M files) + truncation banner if hit
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


### Safe Android storage cleaner
The Storage tab uses the browser File System Access API only after the user explicitly selects a phone-storage or SD-card directory. It never deletes automatically: moving duplicates requires a second confirmation, copies the file first, and removes the source only after a successful copy. Deletion is a separate explicit confirmation action.
