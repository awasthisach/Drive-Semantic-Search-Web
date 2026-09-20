# Drive Semantic Search

Client-side web app: Google Drive sync, hybrid content search, offline pin, vault, and SHA-256 duplicate verification.

**Live:** https://awasthisach.github.io/Drive-Semantic-Search-Web/

## Features

- **Google Drive** — OAuth, My Drive / All drives / Shared Drive, type filters, upload, trash, move, folders, star
- **Token lifecycle** — expiry, silent refresh, revoke on sign-out
- **Auth retry** — `withDriveAuthRetry` on upload, star, move, trash, and hash verify
- **Incremental sync** — Drive **Changes API**; first full list seeds page token; later Sync Now is delta (when type filter = all)
- **Offline pin** — binary or native export → IndexedDB (**true LRU**, 200MB / 80 entries) + SHA-256
- **Vault** — PBKDF2 310k + AES-GCM (Worker + main-thread fallback)
- **Duplicates** — size+name candidates; trash locked until SHA-256 verify
- **Search** — hybrid metadata + **inverted postings** (FTS-style BM25). Re-index builds term→file map. Not neural embeddings
- **Content index** — IndexedDB docs/chunks/postings; stale detection via `driveModifiedTime`; 500k body cap
- **Durable meta** — Drive list snapshot + changes page token per corpus
- **Move** — Dashboard, bulk, Search, Preview
- **PWA** — Vite PWA shell

## Package manager

**npm only** (`package-lock.json` + `npm ci` in CI). Pipeline: `npm ci` → lint (`tsc --strict`) → `npm audit` → test → build → GitHub Pages.

## Scripts

- `npm run dev` / `npm run lint` / `npm test` / `npm run build`

## Honest limits

- Not neural/vector embeddings
- PDF binary OCR not included
- Filtered type syncs still full-list; incremental applies for type=**all**
- Broad `drive` OAuth scope; token in `sessionStorage` (see SECURITY.md)
- Pagination capped (~20k) with truncation banner
- Missing size → **Size unknown** (never invented as 1024)

## Stack

React 19, Vite 6, Tailwind 4, TypeScript **strict**, Firebase Auth + GIS, Drive API v3, IndexedDB inverted postings, Web Crypto, Vitest 5.

## Resilience

- Drive list + mutations use `fetchWithBackoff` (429/403 + Retry-After + jitter)
- Offline pin cancels in-flight work via `AbortController`
- Content index prune is corpus-scoped and skipped when list is truncated
