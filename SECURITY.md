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
| Firebase web `apiKey` | **Public client config** in `firebase-applet-config.json` (required by Firebase/GIS in the browser). Not a private server secret. Restrict by HTTP referrer / app in [Google Cloud Credentials](https://console.cloud.google.com/apis/credentials). Rotate only if the key is abused without API restrictions. |
| OAuth client ID | Public (embedded in SPA); protect with authorized JavaScript origins |
| Duplicates | Size+name = candidates; SHA-256 only after offline pin / export |
| Offline cache | Soft quota ~200 MB / 80 entries; browser quota may be lower |

## Secret scanning note

GitHub Secret Scanning may flag the Firebase `apiKey` (`AIza…`). That is expected for Firebase web apps. Dismiss the alert as **false positive** after confirming API key restrictions (HTTP referrers: `https://awasthisach.github.io/*`, `http://localhost:3000/*`). Do **not** commit real server secrets (`GEMINI_API_KEY`, Cloudflare tokens, service accounts).

## Reporting a vulnerability

Please open a **private** security advisory on GitHub (Security → Advisories → New draft advisory), or email the repository owner via the GitHub profile contact.

Do **not** file public issues for unfixed token/XSS/Drive-abuse findings.

Include:

1. Impact description
2. Steps to reproduce
3. Affected commit SHA if known

We aim to acknowledge reports within 14 days.
