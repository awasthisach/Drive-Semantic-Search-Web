# Drive Semantic Search

Client-side web app: Google Drive sync, hybrid content search, offline pin, vault, and SHA-256 duplicate verification.

**Live:** https://awasthisach.github.io/Drive-Semantic-Search-Web/

## Features

- **Google Drive** — OAuth, My Drive / All drives / Shared Drive, type filters, upload, trash, move, folders, star
- **Token lifecycle** — expiry, silent refresh, revoke on sign-out
- **Auth retry** — `withDriveAuthRetry` on upload, star, move, trash, and hash verify (one refresh + retry on 401)
- **Offline pin** — binary or native export → IndexedDB (**true LRU**, 200MB / 80 entries) + SHA-256; preview from cache
- **Vault** — PBKDF2 310k + AES-GCM (Worker + main-thread fallback), IndexedDB ciphertext
- **Duplicates** — size+name **candidates** (unknown size excluded); **trash locked** until SHA-256 verify
- **Search** — **hybrid**: metadata keywords + extracted body (BM25-style). Index Docs/Sheets/text first. Not neural embeddings
- **Content index** — durable IndexedDB body index; stores `driveModifiedTime` for **stale detection**; re-index skips fresh files; orphans pruned on sync/delete; bodies capped at **500k characters**
- **Durable meta** — Drive list snapshot per corpus (`user` / `allDrives` / `drive:<id>`) in IndexedDB; restored after refresh
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
- Content index is not fully automatic — use **Index extractable content**; it skips already-fresh files via `modifiedTime`
- Broad `drive` OAuth scope (list + mutate)
- Access token in `sessionStorage` (SPA constraint; see SECURITY.md)
- Vault unlock is passphrase-based client-side only
- Pagination capped (~20k) with truncation banner
- Missing Drive API size → shown as **Size unknown** (never invented as 1024)
- Large-scale search still scans IndexedDB chunks (no inverted index yet)

## Stack

React 19, Vite 6, Tailwind 4, Firebase Auth + GIS, Drive API v3, IndexedDB, Web Crypto + Worker, Vitest 5.
