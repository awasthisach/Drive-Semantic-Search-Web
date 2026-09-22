# E2E smoke (optional)

Install Playwright when ready:

```bash
npm i -D @playwright/test
npx playwright install chromium
```

Suggested cases (`e2e/smoke.spec.ts`):

1. Empty index + query \u2192 CTA "Index extractable content"
2. Select all visible \u2192 only PAGE_SIZE (60) selected
3. Miss-query \u2192 results area still responsive within 3s
4. ErrorBoundary not shown on normal load

Run against `npm run preview` (port 4173).
