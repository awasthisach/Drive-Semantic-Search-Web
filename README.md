# Drive Semantic Search

Client-side web app: Google Drive sync, hybrid content search, offline pin, vault, and SHA-256 duplicate verification.

**Live:** https://awasthisach.github.io/Drive-Semantic-Search-Web/

## Features

- **Google Drive** — OAuth, My Drive / All drives / Shared Drive, type filters, upload, trash, move, folders, star
- **Token lifecycle** — expiry, silent refresh, revoke on sign-out; mutation paths use `withDriveAuthRetry`
- **Offline pin** — binary or native export → IndexedDB (**true LRU**, 200MB / 80 entries) + SHA-256; preview from cache
- **Vault** — PBKDF2 310k + AES-GCM (Worker + main-thread fallback), IndexedDB ciphertext
- **Duplicates** — size+name **candidates** (size must be known); **trash locked** until SHA-256 verify; Verify candidates/group queue
- **Search** — **hybrid**: metadata keywords + extracted body (BM25-style). Index Docs/Sheets/text first. Not neural embeddings
- **Durable meta** — last successful Drive list snapshot restored from IndexedDB after refresh
- **Move** — Dashboard card, bulk select, Search results, File preview
- **PWA** — Vite PWA shell

## Package manager

**npm only** (`packageManager: npm@10`). Vitest **5.x**. CI: install → lint → test → build → GitHub Pages.

## Scripts

- `npm run dev` — local
- `npm run lint` — `tsc --noEmit`
- `npm test` — vitest unit tests
- `npm run build` — production

## Honest limits

- Not neural/vector embeddings (hybrid lexical on extracted text)
- PDF binary OCR not included (Google Docs/Sheets/text extract work)
- Broad `drive` OAuth scope (list + mutate)
- Access token in `sessionStorage` (SPA constraint; see SECURITY.md)
- Vault unlock is passphrase-based client-side only
- Pagination capped (~20k) with truncation banner
- Missing Drive API size → shown as **Size unknown** (never invented as 1024)

## Stack

React 19, Vite 6, Tailwind 4, Firebase Auth + GIS, Drive API v3, IndexedDB, Web Crypto + Worker, Vitest 5.
