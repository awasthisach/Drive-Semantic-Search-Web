# Drive Semantic Search

Client-side web app for Google Drive: sync, hybrid keyword search, offline pin, encrypted vault, and SHA-256 duplicate verification.

**Live:** https://awasthisach.github.io/Drive-Semantic-Search-Web/

## Features

- **Google Drive** — OAuth (GIS/Firebase), My Drive / All drives / Shared Drive, type filters, upload, trash, move, folders, star
- **Token lifecycle** — expiry, silent refresh, revoke on sign-out; `withDriveAuthRetry` on mutations
- **Incremental sync** — Drive Changes API; full list seeds page token; delta Sync Now when type filter = all
- **Search** — hybrid metadata + inverted postings (BM25). Highlight chips + match reasons. Inline Star / Pin offline / Copy link on results. Hindi/Hinglish query expansion (lightweight pairs)
- **Content index** — IndexedDB docs/chunks/postings; stale detection; cancel + progress; **resume cursor** after interrupt
- **Select all visible** — pagination-aware (current page only)
- **Offline pin** — IndexedDB LRU + SHA-256; browser storage quota shown on Offline tab
- **Vault** — PBKDF2 310k + AES-GCM (Worker + main-thread fallback)
- **Duplicates** — size+name candidates; trash locked until SHA-256 verify; durable hash snapshot
- **Local diagnostics** — ring buffer; header **Diagnostics** export (tokens redacted)
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

## Local pre-push (optional)

```bash
git config core.hooksPath .githooks
```

Runs `lint` + `test` + `build` before every push. Enable GitHub branch protection: require Deploy workflow checks on `main`.

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
