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
| Search | Metadata / keyword ranking — **not** full-document embeddings |
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

## Best practices for users

- Sign out when finished (revokes token when possible)
- Do not use this app on a shared/untrusted computer while signed in
- Treat vault notes as device-local encrypted storage, not zero-knowledge cloud backup

## Recommended browser / hosting hardening

This app is a static SPA on GitHub Pages, so tokens must live in the page context. Mitigations:

1. **Sign out when done** — clears `sessionStorage` token and attempts revoke.
2. **Prefer trusted devices** — any XSS on this origin can read the active access token.
3. **CSP (hosting layer)** — if you put a reverse proxy or custom domain in front, set a strict Content-Security-Policy (default-src, script-src, connect-src limited to Google APIs and your origin).
4. **Do not embed this app in untrusted iframes** — use `frame-ancestors 'none'` when possible.
5. **Broad Drive scope** is required for trash/move/upload/star in-browser; a read-only mode would need a separate OAuth client and reduced feature set.

Backend token proxy / httpOnly cookies are **out of scope** for pure GitHub Pages static hosting.
