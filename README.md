# Drive Semantic Search Web

A client-side progressive web app for browsing Google Drive with hybrid search, offline pinning, duplicate review, and an encrypted notes vault.

- **Live app:** <https://awasthisach.github.io/Drive-Semantic-Search-Web/>
- **Embedding Worker:** <https://drive-semantic-embed.awasthi-sach.workers.dev>
- **Security policy:** [SECURITY.md](SECURITY.md)
- **Data-consistency audit and remediation record:** [DATA-CONSISTENCY-AUDIT.md](DATA-CONSISTENCY-AUDIT.md)

> The app runs in the browser and calls Google Drive directly. Search indexes, pinned file bytes, and vault records are stored locally in browser IndexedDB; these stores have different protection properties. See [Privacy and security](#privacy-and-security).

## What the app does

- **Drive browsing and management:** My Drive, All drives, or a selected Shared Drive; file-type filters; folders; upload; move; star; and trash.
- **Incremental synchronization:** full-list initialization followed by the Google Drive Changes API when the file-type filter is set to **All**. Change pagination is bounded; a capped/incomplete drain fails without advancing its checkpoint. See [Sync and consistency behavior](#sync-and-consistency-behavior).
- **Hybrid search:** metadata, BM25 ranking over extracted text, and optional neural similarity. Search still works using metadata and BM25 when neural embeddings are not configured or available.
- **Content indexing:** extracts supported text into local IndexedDB documents, chunks, and postings. Text is capped at 500,000 characters per file; the cap is recorded as truncation. Vector embeddings use 768 dimensions and are versioned separately.
- **Offline pinning:** saves downloaded/exported bytes in a bounded local cache (nominal limits: 200 MB total and 80 files; the browser’s actual quota can be lower).
- **Duplicate review:** groups either SHA-256-confirmed copies or weaker same-size/name candidates. Candidate groups cannot be trashed until verification. Hash verification is tied to the Drive file revision it checked.
- **Semantic near-duplicate review:** groups similar file-level embedding centroids for human review and move actions. It never enables automatic trash.
- **Encrypted vault:** protects stored vault entries with PBKDF2 key derivation and AES-GCM encryption. It does not encrypt the separate search indexes or offline cache.
- **Device storage scanner:** user-selected phone/SD-card directory review where the browser supports the File System Access API. The app does not silently remove files.
- **PWA shell:** installable web app with cached application assets and automatic updates.
- **Local diagnostics:** a bounded privacy-oriented event buffer with token/email redaction on export.

## Search and indexing

The search pipeline combines three signals:

| Signal | Availability | Notes |
|---|---|---|
| Metadata | Always | Names, summaries, tags, and file metadata. |
| BM25 body | After content indexing | Local IndexedDB postings over extracted text. |
| Neural similarity | Optional | Firebase-authenticated browser request → Cloudflare Worker → Gemini embeddings → local vector search. Requires a configured/reachable Worker and compatible indexed vectors. |

The hybrid weights in `src/lib/searchEngine.ts` are experimental/provisional, not calibrated on a representative production corpus. Treat search ranking as a useful retrieval aid, not a quality guarantee. Hindi/Hinglish query expansion is lightweight and rule-based; it is not a full translation system.

For larger vector collections, the app uses a versioned, rebuildable IndexedDB locality-sensitive hashing (LSH) candidate index and exact cosine reranking of those candidates. This is **approximate retrieval**: a non-empty ANN candidate set can omit a true nearest neighbor. An exact scan is used when the ANN path returns no qualified hit. The deterministic relevance fixture is a regression test, not evidence of production recall on real Drive files or Gemini embeddings.

### Supported text extraction

Current extraction supports Google Docs (text export), Sheets (CSV export), Slides (text export), and text-like files such as TXT, CSV, Markdown, HTML, JSON, XML, and logs. It does not implement browser-side PDF/DOCX/XLSX/PPTX parsing or OCR. Google-native content is indexed from its text export representation; SHA verification hashes downloaded bytes or the corresponding Google export bytes, not an abstract native-document representation.

## Sync and consistency behavior

- A complete **All files** listing captures its Changes API start token before enumeration, saves a complete snapshot, completes safe index pruning, and only then persists the token. Changes made while listing are therefore eligible for the next incremental drain.
- An incremental run applies the change batch, removes deleted-file index data, persists the updated snapshot, and writes the new checkpoint last. If interrupted before checkpoint advancement, the old checkpoint causes safe replay rather than silently skipping that batch.
- Change-page exhaustion without `newStartPageToken` is an explicit incomplete-sync error. The app does not advance the checkpoint or claim the capped result is current.
- Incremental deletion and full-list pruning are corpus-aware. Pruning is skipped for filtered file types and incomplete/truncated full listings.
- Replacing one BM25 document, its chunks, and postings is performed in a single IndexedDB read-write transaction. IndexedDB stores for BM25 content and vectors are separate, so no browser transaction can atomically commit across both; vector-cleanup failures are propagated rather than hidden, and retry/re-index is the repair path.
- SHA-256 hashes are retained only with the `modifiedTime` of the revision whose bytes were verified. Hashing rechecks that revision, and a Drive edit invalidates the old verified state. A stale offline cache hash is not restored as verified for a different current Drive revision.
- These protections are application-level crash/replay safeguards, not a substitute for backing up browser-local data. Clearing browser site data deletes the local indexes and offline cache.

## Privacy and security

This is a browser application, not a hosted Drive data-processing backend. However, “client-side” does **not** mean every piece of data is encrypted or never leaves the browser:

| Data | Where it is used/stored | Protection and caveat |
|---|---|---|
| Google Drive metadata/content | Requested directly from Google Drive in the browser | Drive OAuth uses the broad `drive` scope, including mutation privileges. Access tokens are held in `sessionStorage`; active-origin XSS can expose a token. |
| Extracted search text | BM25 document/chunk/posting IndexedDB database | Stored locally in ordinary IndexedDB, not inside the encrypted vault. When neural embedding is enabled, text/chunks are sent to the configured Worker and its Gemini embedding provider. |
| Vector records | Separate local IndexedDB vector database | Stores embeddings and corresponding chunk text. These records are not vault-encrypted. |
| Offline-pinned files | Offline-cache IndexedDB database | Stores file bytes and metadata locally without vault encryption. Browser storage may be evicted or quota-limited. |
| Vault entries | Vault-specific IndexedDB store | The stored payload is encrypted with AES-GCM; PBKDF2 derives the key. This is not protection against malicious JavaScript/XSS running on the same origin. |
| Firebase web config and OAuth client ID | Public frontend config | Expected to be visible in the browser. Restrict the Firebase API key and OAuth client origins in Google Cloud/Firebase settings. |
| Gemini API key and Cloudflare credentials | Server-side Worker / GitHub Actions secrets | Never place these values in `VITE_*`, frontend config, committed files, or a browser bundle. |

See [SECURITY.md](SECURITY.md) for the repository’s security policy and reporting process. Avoid running the app in an untrusted browser profile or granting Drive access to a deployment origin you do not trust.

## Local development

### Requirements

- Node.js 22 (the CI workflows use Node 22)
- npm 10-compatible package manager
- A modern browser for OAuth and IndexedDB behavior

### Start the app

```bash
git clone https://github.com/awasthisach/Drive-Semantic-Search-Web.git
cd Drive-Semantic-Search-Web
npm ci
npm run dev
```

Vite binds to `0.0.0.0:3000`; open <http://localhost:3000/>. The PWA service worker is disabled in development.

### Validate changes

```bash
npm run lint            # TypeScript check (tsc --noEmit)
npm test                # Complete Vitest suite
npm run test:idb        # IndexedDB content-index tests
npm run evaluate:relevance  # Deterministic ANN regression/evaluation fixture
npm run build           # Production Vite build
npm run check:bundle    # Bundle-size budget check
```

The relevance command uses synthetic, deterministic vectors. It does not access user Drive data and is not a production semantic-search benchmark.

## Authentication and app configuration

Google sign-in and Drive access require the Firebase/Google Identity Services configuration used by `src/lib/firebaseAuth.ts` and `firebase-applet-config.json`.

1. Configure Firebase Authentication and enable Google sign-in.
2. Enable the Google Drive API for the corresponding Google Cloud project.
3. Add the deployed origin and local development origin (`http://localhost:3000`) to the appropriate authorized JavaScript origins / OAuth settings.
4. Restrict the Firebase web API key to the intended referrers and APIs.
5. Sign in and grant the Drive permissions requested by the app.

Frontend configuration is public by design. **Never** put `GEMINI_API_KEY`, a Cloudflare API token, service-account credentials, or other server-side secrets in `VITE_*` variables or committed files.

## Optional neural-search Worker

The optional Worker lives under `workers/embed` and proxies embedding requests to Gemini. Its contract includes authenticated requests and a versioned response compatible with the browser’s embedding configuration. Relevant settings are in `workers/embed/wrangler.toml`:

- Worker name: `drive-semantic-embed`
- Model: `gemini-embedding-2`
- Dimension: `768`
- Firebase project ID and allowed browser origin
- Request-size, text-length, and per-isolate rate limits

For local Worker validation:

```bash
cd workers/embed
npm ci
npm run check
```

Configure `GEMINI_API_KEY` as a **Cloudflare Worker secret**, not a plain committed variable. Configure `FIREBASE_PROJECT_ID` and `ALLOWED_ORIGIN` for the intended app. The in-memory rate limiter is per Worker isolate; it is a best-effort guard, not a globally durable account quota.

### Production deployment

The consolidated workflow is `.github/workflows/deploy.yml`:

- Pull requests targeting `main` run typecheck, placeholder guard, production dependency audit, tests, build, bundle check, and Worker dry run. They do not deploy.
- A push to `main` runs those gates, deploys the Worker, requires a live authenticated Worker contract check, and deploys the Pages site only when the Worker job succeeds.
- A manual `workflow_dispatch` from `main` can run the same deployment sequence. Starting it from another branch runs checks but does not deploy.
- The authenticated contract check requires the CI secrets `FIREBASE_TEST_EMAIL` and `FIREBASE_TEST_PASSWORD`, in addition to `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. Use a dedicated low-privilege Firebase test account. Missing required credentials fail the deployment gate rather than silently downgrading to an unauthenticated-only test.
- `VITE_EMBED_ENDPOINT` is optional public configuration; if unset, the workflow uses the documented public Worker URL. It is not a secret.
- GitHub Pages production deployment is restricted to `main`. Repository branch protection and required status-check settings must still be configured in GitHub repository settings.

`.github/workflows/verify-lockfile.yml` is a read-only lockfile consistency check. It does not push commits into a protected branch; update `package-lock.json` with dependency changes and commit it with `package.json`.

After deployment, verify actual OAuth sign-in, Drive listing, content indexing, a semantic search, BM25/metadata fallback, and duplicate review in the live browser. Green CI proves only the checks described above; it cannot certify every real user account, Drive corpus, browser quota, or search ranking.

## Duplicate behavior

- **SHA-256 group:** files whose verified bytes or exported bytes have matching SHA-256 are marked `verification: 'sha256'`. Hashing is sequential and may take time for many large candidates; failed verification does not certify a file.
- **Candidate group:** same size and normalized name is only a review candidate. It is not proof of identical contents, and the UI keeps trash locked until SHA verification.
- **Semantic group:** files are grouped through threshold-passing centroid-similarity links. This connected-group behavior can include members that are not directly above threshold with every other member. The displayed percentage is the **best direct pair** in the group, not a pairwise guarantee. Semantic groups are review/move-only; they do not authorize trash.

## Repository layout

```text
src/components/       React screens and dialogs
src/hooks/            App state and Drive action hooks
src/lib/              Drive APIs, sync, extraction, indexes, search, crypto
src/lib/embeddings/   Embedding client, config, and vector math
src/lib/__tests__/    Vitest unit and IndexedDB regression tests
workers/embed/        Cloudflare Worker embedding proxy
scripts/              Build-size and live-contract validation tools
.github/workflows/    Main deployment and lockfile-consistency workflows
```

## Current limitations

- No full PDF/Office parsing or OCR pipeline in the browser.
- Neural ranking weights and ANN recall are not validated on a representative production Drive corpus.
- Semantic similarity is a review signal, not proof of identical files or a safe-delete decision.
- Export-based hashes for native Google files identify the downloaded export bytes; different export representations can affect matching.
- Browser-local IndexedDB can be cleared, evicted, or run out of quota; local data is not backed up by this repository.
- The app’s broad Drive OAuth scope, token storage, plaintext local search/offline stores, and XSS threat model are described in [SECURITY.md](SECURITY.md).
- The Worker’s in-memory rate limiter is isolate-local and not a global quota system.

## Technology

React 19 · TypeScript · Vite 6 · Tailwind CSS 4 · Firebase Authentication / Google Identity Services · Google Drive API v3 · IndexedDB · Web Crypto · Vitest · optional Cloudflare Workers and Gemini embeddings.
