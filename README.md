# Drive Semantic Search

Client-side web app for Google Drive: sync, **hybrid search** (neural cosine + BM25 + metadata), offline pin, encrypted vault, and SHA-256 duplicate verification.

**Live:** https://awasthisach.github.io/Drive-Semantic-Search-Web/

**HEAD notes:** Search code supports neural retrieval when an embed Worker is configured. Without `VITE_EMBED_ENDPOINT`, the live site runs **BM25 + metadata only**.

---

## Features

- **Google Drive** — OAuth (GIS/Firebase), My Drive / All drives / Shared Drive, type filters, upload, trash, move, folders, star
- **Token lifecycle** — expiry, silent refresh, revoke on sign-out; `withDriveAuthRetry` on mutations
- **Incremental sync** — Drive Changes API; full list seeds page token; delta Sync Now when type filter = all
- **Hybrid search**
  - **Metadata** — filename, summary, tags (exact name boost)
  - **BM25 body** — IndexedDB postings over extracted Drive text
  - **Neural (optional)** — Gemini embeddings via authenticated Worker → cosine over chunk vectors → hybrid blend
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
     │
     ▼
Incremental extract / index
     │
     ├──────────────┬──────────────┐
     ▼              ▼              ▼
 Metadata      BM25 index     Vector index (768-d)
     │              │              │
     └──────────────┼──────────────┘
                    ▼
              Hybrid ranking
     (provisional weights — see below)
```

| Signal | When active |
|--------|-------------|
| Metadata | Always |
| BM25 body | After “Index extractable content” |
| Neural cosine | `VITE_EMBED_ENDPOINT` set **and** vectors stored during index |

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

Neural ranking is **code-complete** but **off** on Pages until the Worker URL is baked into the SPA build.

### 1. Deploy embed Worker

```bash
cd workers/embed
cp wrangler.toml.example wrangler.toml
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put FIREBASE_PROJECT_ID   # e.g. thevvforg
npx wrangler deploy
```

Worker expects Firebase ID token (JWKS-verified), exact CORS origin, rate limit, retry/backoff. Model: **`gemini-embedding-2`**, dimension **768** (must match SPA).

### 2. Point the SPA at the Worker

Build-time env (must start with `http`):

```bash
VITE_EMBED_ENDPOINT=https://<your-worker>.workers.dev
```

For GitHub Pages CI, add a repository secret `VITE_EMBED_ENDPOINT` and pass it into the build step in `.github/workflows/deploy.yml`:

```yaml
- name: Build project
  env:
    VITE_EMBED_ENDPOINT: ${{ secrets.VITE_EMBED_ENDPOINT }}
  run: npm run build
```

Without this, `isEmbedConfigured()` is false → neural path stays disabled.

### 3. Index + verify

1. Sign in on the live app  
2. **Index extractable content** (writes BM25 + vectors when endpoint is set)  
3. Query cross-language cases (e.g. `बेरोजगारी` vs English “employment / joblessness” docs)  
4. Confirm exact filename still ranks; embed downtime still returns BM25 results  

**Live multilingual proof cannot be claimed from unit tests alone** — those only verify cosine/ranking math with synthetic vectors.

---

## Honest limits

- Live neural requires Worker + `VITE_EMBED_ENDPOINT` + re-index; default Pages build may be BM25-only
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

---

## Security

- **Never** put `GEMINI_API_KEY` in `VITE_*` or the SPA bundle
- Browser sends Firebase **ID token** only to the Worker
- See [SECURITY.md](SECURITY.md). Report vulnerabilities via private GitHub advisory.
