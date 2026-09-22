# Embed worker (Phase 3)

Authenticated proxy: browser sends **Firebase ID token** only; **GEMINI_API_KEY** stays in Worker secrets.

## Deploy (Cloudflare)

```bash
cd workers/embed
cp wrangler.toml.example wrangler.toml
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put FIREBASE_PROJECT_ID   # e.g. thevvforg
npx wrangler deploy
```

Set SPA env (public URL only):

```bash
# .env.local (not committed)
VITE_EMBED_ENDPOINT=https://drive-semantic-embed.<your-subdomain>.workers.dev
```

## Security checklist

- [ ] GEMINI_API_KEY never in `VITE_*` or frontend source
- [ ] Production: replace JWT payload parse with full JWKS signature verify
- [ ] Restrict CORS `Access-Control-Allow-Origin` to your Pages origin
- [ ] No request body text written to logs

## Not wired yet

Phase 4 will call `createEmbeddingProvider()` from indexing + search.
