# Security Policy

## Supported versions

Only the latest `main` branch of this repository is supported.

## What this app does

Drive Semantic Search is a **client-side browser SPA** that:

- Obtains a Google OAuth access token (Drive scope) via Google Identity Services / Firebase Auth
- Calls the Google Drive API directly from the browser
- Stores offline-pinned file bytes and vault ciphertext in **IndexedDB**
- Derives vault keys with **PBKDF2 (310k) + AES-GCM** in a Web Worker (main-thread fallback)

## Known limitations (not considered secret)

| Topic | Status |
|-------|--------|
| OAuth scope | Broad `https://www.googleapis.com/auth/drive` (read + mutate) |
| Access token storage | `sessionStorage` (XSS can expose an active token) |
| Vault threat model | Protects against casual device access when locked; **not** against XSS on this origin |
| Search | Hybrid metadata + BM25 body ranking; neural embeddings are **opt-in via backend /embed** (not in SPA secrets) |
| Embedding API key | **Server-side only** (Worker secret). Never `VITE_GEMINI_*` |
| Duplicates | Size+name = candidates; SHA-256 only after offline pin / export |
| Offline cache | Soft quota ~200 MB / 80 entries; browser quota may be lower |

## Reporting a vulnerability

Please open a **private** security advisory on GitHub (Security → Advisories → New draft advisory), or email the repository owner via the GitHub profile contact.

Do **not** file public issues for unfixed token/XSS/Drive-abuse findings.

Include:

1. Impact description
2. Steps to reproduce
3. Affected commit SHA if known

We aim to acknowledge reports within 14 days.
