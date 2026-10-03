# Drive Semantic Search Web

A browser-first progressive web app for Google Drive browsing, hybrid search, bounded document indexing, duplicate review, existing-folder suggestions, offline pinning, and an encrypted notes vault.

- **Live app:** <https://awasthisach.github.io/Drive-Semantic-Search-Web/>
- **Embedding Worker:** <https://drive-semantic-embed.awasthi-sach.workers.dev>
- **Security policy:** [SECURITY.md](SECURITY.md)
- **Data-consistency audit:** [DATA-CONSISTENCY-AUDIT.md](DATA-CONSISTENCY-AUDIT.md)

> Drive access and extraction run in the browser. Search text, document vectors, offline-pinned bytes, and vault entries are stored in separate browser-local stores with different protection properties. Some explicitly consented embedding operations send text or folder labels to the configured Worker. See [Privacy and security](#privacy-and-security).

## Features

- **Drive browsing and management:** My Drive, All drives, or a selected Shared Drive; file filters; upload, move, star, and trash actions.
- **Incremental synchronization:** full-list initialization followed by the Google Drive Changes API when the file-type filter is **All**. Incomplete/capped change drains do not advance the checkpoint.
- **Hybrid search:** metadata, BM25 over locally indexed text, and optional neural similarity. Metadata/BM25 remain available when semantic embeddings are disabled or unavailable.
- **Content indexing:** indexes Google-native exports, supported text files, DOCX, XLSX, PDFs, and images in the browser. Each file is capped at 500,000 indexed characters; the app records truncation.
- **Bounded PDF profiles:** PDFs up to 10 pages include every page. Longer PDFs initially include only pages 1–5 and the last 5. Native selectable text is preferred; OCR is attempted only on sampled pages with sparse text.
- **Folder-category suggestions:** ranks an indexed file against names of the existing folders in the current Drive corpus, including available parent-folder names. A suggestion only preselects a destination in the normal move dialog; the app never moves a file automatically.
- **Duplicate review:** separates revision-verified SHA-256 matches, weaker size/name candidates, and semantic near-duplicate suggestions. Semantic suggestions never unlock trash.
- **Offline pinning:** saves downloaded/exported bytes to a bounded local cache (nominal limits: 200 MB total and 80 files; browser quota may be lower).
- **Encrypted vault:** encrypts vault payloads using PBKDF2-derived keys and AES-GCM. The vault does not encrypt separate search indexes or the offline cache.
- **Device storage scanner:** reviews a user-selected phone/SD-card directory where the browser supports the File System Access API. It does not silently delete files.
- **PWA shell and diagnostics:** installable app shell with cached application assets, plus a bounded diagnostics buffer with token/email redaction on export.

## Search and indexing

The search pipeline combines three signals:

| Signal | Availability | Notes |
|---|---|---|
| Metadata | Always | Names, summaries, tags, and file metadata. Exact filename matching is handled here. |
| BM25 body | After content indexing | Local IndexedDB postings over extracted text. |
| Neural similarity | Optional | Firebase-authenticated browser request → Cloudflare Worker → Gemini embeddings → local vector search. Requires embedding consent, a configured/reachable Worker, and compatible vectors. |

Neural **document vectors are content-only** so renaming a file does not alter its semantic content profile. Filenames remain searchable through the metadata signal; BM25 indexes extracted body text. After upgrading from an earlier build that embedded a title into each vector, set the Search scope to **All** and press **Index / Rebuild** once to migrate stored vectors. Compatible cached extracted text is reused for that migration; PDFs with missing/outdated extraction-policy metadata are re-extracted using the bounded policy below. Duplicate and folder-suggestion screens exclude legacy filename-bearing profiles until they are migrated.

The hybrid weights in `src/lib/searchEngine.ts` are provisional and are not calibrated against a representative production corpus. Hindi/Hinglish query expansion is lightweight and rule-based, not a full translation system.

For larger vector collections, search uses a versioned, rebuildable IndexedDB locality-sensitive hashing (LSH) candidate index and exact cosine reranking of those candidates. This is approximate retrieval: a non-empty ANN candidate set can omit a true nearest neighbor. An exact scan is used when the ANN path returns no qualified hit. The deterministic relevance fixture is a regression test, not a production recall benchmark.

### Supported extraction

- **Google Docs:** Drive text export.
- **Google Sheets:** CSV export.
- **Google Slides:** plain-text export.
- **Text-like files:** TXT, CSV, Markdown, HTML, JSON, XML, and logs.
- **DOCX/XLSX:** lightweight browser-side extraction from their Office Open XML containers; these are not full-fidelity Office renderers. PPTX parsing is not implemented.
- **PDF:** PDF.js extracts selectable text page by page. Scanned/sparse-text pages use Tesseract.js OCR (`eng+hin`) only when they are in the selected sample.
- **Images:** browser-side Tesseract.js OCR for supported image types.

Binary extraction is limited to 50 MB per file and one file’s download/extract/OCR has a default 90-second timeout. Browser memory, storage quotas, network quality, PDF quality, and OCR quality can still affect results.

### PDF page and OCR policy

| PDF length / action | Pages included in the local semantic profile | OCR behavior |
|---|---|---|
| 1–10 pages | Every page | Use native text when it is sufficient; OCR a page only when its text layer is sparse. |
| More than 10 pages, normal indexing | First 5 + last 5 pages | Same page-level native-text-first policy; unselected middle pages are deferred. |
| Borderline semantic duplicate pair, explicit deep check | The first/last sample plus up to 5 evenly spaced middle pages | Reprocesses those PDF samples only; it does not OCR the entire book. |

A text layer is treated as sparse when it has fewer than 45 characters or fewer than 6 letter/number words. This is a practical heuristic, not a guarantee for every language or layout. The indexed record stores the extraction policy, sampled page numbers, OCR-attempted/successful pages, and count of deferred pages.

**Important:** for a PDF longer than 10 pages, the initial profile is deliberately partial. Content found only on omitted middle pages can be missed by search or duplicate detection. A deep check improves evidence for a surfaced borderline pair but still does not provide full-book coverage. Page coverage is visible in the indexing status and stored with the local indexed document.

## Folder suggestions and duplicate review

### Suggest a folder from existing Drive folders

1. Sync the desired Drive corpus so its current folder list and parent IDs are available.
2. In **Search**, index the target document with embeddings enabled.
3. Choose one indexed Drive file in **Suggest an existing Drive folder** and request suggestions.
4. Review the ranked folder names and cosine scores. The score is not a probability or calibrated confidence.
5. **Review move** opens the existing move dialog with that folder preselected. The file moves only after the user confirms **Move … Here**.

The feature uses the selected file’s local semantic profile and embeds only current folder names/parent names for comparison. It does not create new categories, invent folder destinations, or move files automatically.

### Duplicate signals

- **SHA-256 confirmed:** matching SHA-256 for the exact Drive revision checked. Hash verification is the only proof-grade duplicate signal used to unlock trash; verification can be slow for many large files. A Drive edit invalidates the hash for the old revision.
- **Size/name candidate:** same size and normalized name is a weak review candidate, not proof. Trash remains locked until SHA-256 verification succeeds.
- **Semantic near-duplicate:** compares body-only embeddings across multiple chunks in order; file names and byte sizes are not comparison gates. One shared generic chunk is insufficient for a multi-chunk profile. Same-topic documents are not proof of duplicates.

The semantic scan is bounded: it considers at most 500 file profiles, uses up to 12 representative chunks per file, and shortlists centroid-nearest pairs before ordered chunk-overlap scoring. The default content-match threshold is 90%; 85% and 95% are also available. Pairs within five points below the selected threshold are surfaced as **borderline**. If applicable, a user can request more sampled pages for those PDF pairs and then rerun the scan. If live profiles still contain the older title-bearing vector format, the scan asks for the one-time All-scope reindex rather than mixing profile formats.

Semantic groups are connected review groups: a member may be linked indirectly rather than exceeding the threshold with every other member. The displayed score is the best direct pair in that group, not a pairwise guarantee. Semantic matches are for human review and move actions only; they never unlock or trigger automatic trash.

## Sync and consistency behavior

- A complete **All files** listing captures its Changes API start token before enumeration, saves a complete snapshot, completes safe index pruning, and only then persists the token. Changes made while listing are eligible for the next incremental drain.
- An incremental run applies the change batch, removes deleted-file index data, persists the updated snapshot, and writes the new checkpoint last. If interrupted before checkpoint advancement, the old checkpoint causes safe replay rather than silently skipping the batch.
- Change-page exhaustion without `newStartPageToken` is an explicit incomplete-sync error. The app does not advance the checkpoint or claim the capped result is current.
- Incremental deletion and full-list pruning are corpus-aware. Pruning is skipped for filtered file types and incomplete/truncated full listings.
- Replacing one BM25 document, its chunks, and postings is performed in a single IndexedDB read-write transaction. BM25 and vector stores are separate IndexedDB databases; no browser transaction can atomically commit across both.
- SHA-256 hashes are retained only with the `modifiedTime` of the revision whose bytes were verified. A stale offline-cache hash is not restored as verified for a different current Drive revision.
- These are application-level crash/replay safeguards, not a substitute for backing up browser-local data. Clearing browser site data deletes local indexes and the offline cache.

## Privacy and security

This is a browser application, not a hosted Drive data-processing backend. “Client-side” does **not** mean all data is encrypted or never leaves the browser.

| Data | Use/storage | Protection and caveat |
|---|---|---|
| Google Drive metadata/content | Requested directly from Google Drive in the browser | OAuth uses the broad `drive` scope, including mutation privileges. Access tokens are held in `sessionStorage`; active-origin XSS can expose a token. |
| Extracted text and BM25 index | Browser-local IndexedDB | Stored as ordinary local text, not inside the vault. When semantic embeddings are enabled with consent, document chunks are sent to the configured Worker for embedding. |
| Vector records | Separate local IndexedDB vector database | Stores content-only embeddings and corresponding chunk text. Not vault-encrypted. |
| Folder-category labels | Current Drive folder names/parent names are sent to the configured embedding Worker only when the user requests suggestions and embedding consent is enabled. | File content is not re-sent by the category-suggestion panel; suggestions are calculated against its existing local vector profile. Folder vectors are cached in page memory only. |
| PDF/image OCR assets | PDF.js/Tesseract.js scripts, WASM and `eng+hin` language data load from public CDNs as needed. | PDF/image bytes are downloaded to and processed in the browser; OCR itself is local. The browser may contact those CDNs for code/language files. |
| Offline-pinned files | Offline-cache IndexedDB database | Stores file bytes and metadata locally without vault encryption; browser storage may be evicted or quota-limited. |
| Vault entries | Vault-specific IndexedDB store | Payload encrypted with AES-GCM using a PBKDF2-derived key. This does not protect against malicious same-origin JavaScript/XSS. |
| Firebase web config and OAuth client ID | Public frontend config | Expected to be visible in the browser. Restrict the Firebase API key and OAuth client origins in Google Cloud/Firebase settings. |
| Gemini API key and Cloudflare credentials | Worker / GitHub Actions secrets | Never put these values in `VITE_*`, frontend config, a browser bundle, or committed files. |

See [SECURITY.md](SECURITY.md) for the repository’s security policy and reporting process. Avoid running the app in an untrusted browser profile or granting Drive access to a deployment origin you do not trust.

## Local development

### Requirements

- Node.js 22 (CI uses Node 22)
- npm 10-compatible package manager
- A modern browser for OAuth, IndexedDB, PDF rendering, and File System Access API behavior

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
npm run lint                 # TypeScript check (tsc --noEmit)
npm test                     # Complete Vitest suite
npm run test:idb             # IndexedDB content-index tests
npm run evaluate:relevance   # Deterministic ANN regression fixture
npm run build                # Production Vite build
npm run check:bundle         # Bundle-size budget check
npm run check:dist           # Verify referenced production assets exist
```

The relevance command uses synthetic deterministic vectors. It does not access user Drive data and is not a production semantic-search benchmark.

## Authentication and app configuration

Google sign-in and Drive access require the Firebase/Google Identity Services configuration used by `src/lib/firebaseAuth.ts` and `firebase-applet-config.json`.

1. Configure Firebase Authentication and enable Google sign-in.
2. Enable the Google Drive API for the corresponding Google Cloud project.
3. Add the deployed origin and local development origin (`http://localhost:3000`) to the authorized JavaScript origins / OAuth settings.
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
- The authenticated contract check requires CI secrets `FIREBASE_TEST_EMAIL` and `FIREBASE_TEST_PASSWORD`, in addition to `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. Use a dedicated low-privilege Firebase test account. Missing credentials fail the deployment gate rather than silently downgrading to an unauthenticated-only test.
- `VITE_EMBED_ENDPOINT` is optional public configuration; if unset, the workflow uses the documented public Worker URL. It is not a secret.
- GitHub Pages production deployment is restricted to `main`. Configure repository branch protection and required status checks in GitHub settings.

`.github/workflows/verify-lockfile.yml` is a read-only lockfile consistency check. It does not push commits into a protected branch; update `package-lock.json` with dependency changes and commit it with `package.json`.

After deployment, verify actual OAuth sign-in, Drive listing, content indexing, semantic and BM25/metadata search, folder suggestions, and duplicate review in a live browser. Green CI cannot certify every user account, Drive corpus, browser quota, OCR outcome, or real-world search/duplicate recall.

## Design references

- [PDF.js page text API](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib-PDFPageProxy.html) — page-level extraction of selectable PDF text.
- [PyMuPDF4LLM hybrid OCR overview](https://pymupdf.io/blog/hybrid-ocr-in-pymupdf4llm) — native-text-first processing and OCR only where extraction is incomplete. Its vendor performance figures are not treated as guarantees for this app.
- [NVIDIA NeMo Curator semantic deduplication](https://docs.nvidia.com/nemo/curator/curate-text/process-data/deduplication/semdedup) — semantic similarity is a thresholded signal, not proof of identical documents.
- [UMass CIIR, Partial Duplicate Detection for Large Book Collections](https://ciir-publications.cs.umass.edu/getpdf.php?id=970) — scanned-book duplicates, OCR noise, ordered content evidence, and the distinction between shared topic and duplicate work.

## Current limitations

- PDFs longer than 10 pages have bounded initial coverage; text found only on unselected middle pages may be missed. Deep checks add at most five middle pages and still do not cover a whole book.
- The sparse-text OCR rule and duplicate thresholds are heuristics. OCR and embeddings can miss true copies or suggest unrelated same-topic files.
- Semantic duplicate analysis is bounded to 500 profiles, 12 representative chunks per profile, and centroid-nearest shortlist pairs; results are not exhaustive proof.
- Neural ranking weights and ANN recall are not validated on a representative production Drive corpus.
- Export-based hashes for native Google files identify the downloaded export bytes; different export representations can affect matching.
- Browser-local IndexedDB can be cleared, evicted, or run out of quota; local data is not backed up by this repository.
- The broad Drive OAuth scope, token storage, plaintext local search/offline stores, and XSS threat model are described in [SECURITY.md](SECURITY.md).
- The Worker’s in-memory rate limiter is isolate-local and not a global quota system.

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

## Technology

React 19 · TypeScript · Vite 6 · Tailwind CSS 4 · Firebase Authentication / Google Identity Services · Google Drive API v3 · PDF.js · Tesseract.js · IndexedDB · Web Crypto · Vitest · optional Cloudflare Workers and Gemini embeddings.
