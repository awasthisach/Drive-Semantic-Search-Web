# Drive Semantic Search

Client-side web app for Google Drive: sync, hybrid keyword search, offline pin, encrypted vault, and SHA-256 duplicate verification.

**Live:** https://awasthisach.github.io/Drive-Semantic-Search-Web/

## Features

- **Google Drive** — OAuth (GIS/Firebase), My Drive / All drives / Shared Drive, type filters, upload, trash, move, folders, star
- **Token lifecycle** — expiry, silent refresh, revoke on sign-out; `withDriveAuthRetry` on mutations
- **Incremental sync** — Drive Changes API; full list seeds page token; delta Sync Now when type filter = all
- **Search** — hybrid metadata + inverted postings (BM25). Highlight chips + match reasons. Inline Star / Pin offline / Copy link on results
- **Content index** — IndexedDB docs/chunks/postings; stale detection via `driveModifiedTime`; 500k body cap; cancel + progress UI
- **Select all visible** — pagination-aware (current page only)
- **Offline pin** — binary or native export → IndexedDB (true LRU, ~200 MB / 80 entries) + SHA-256
- **Vault** — PBKDF2 310k + AES-GCM (Worker + main-thread fallback)
- **Duplicates** — size+name candidates; trash locked until SHA-256 verify; durable hash snapshot
- **Local diagnostics** — ring buffer for errors/sync/search; export JSON (tokens redacted, no telemetry)
- **PWA** — Vite PWA shell, installable

## Stack

React 19 · Vite 6 · Tailwind 4 · TypeScript strict · Firebase Auth + GIS · Drive API v3 · IndexedDB · Web Crypto · Vitest 5

## Scripts

```bash
npm ci
npm run dev      # localhost:3000
npm run lint     # tsc --noEmit
npm test
npm run build
npm run check:bundle
```

**CI:** `npm ci` → lint → audit → test → build → GitHub Pages.

## Honest limits

- Not neural / vector embeddings
- No PDF binary OCR
- Filtered type syncs use full list; incremental only for type = **all**
- Broad `drive` OAuth scope; access token in `sessionStorage` (see [SECURITY.md](SECURITY.md))
- List pagination capped (~20k) with truncation banner
- Missing size → **Size unknown** (never invented)

## Resilience

- `fetchWithBackoff` on Drive list + mutations (429/403, Retry-After, jitter)
- Offline pin cancellable via `AbortController`
- Content-index prune is corpus-scoped and skipped when list is truncated
- Race-free durable meta + hash snapshot persist

## Security

See [SECURITY.md](SECURITY.md). Report vulnerabilities via private GitHub advisory.
