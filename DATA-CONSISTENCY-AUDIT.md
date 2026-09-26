# Drive Semantic Search Web — Data Consistency Audit

**Audit date:** 2026-09-27  
**Repository revision:** `5391421` (`main`)  
**Scope:** source code, tests, and GitHub Actions workflows only. README files were excluded from evidence.  
**Changes:** no tracked repository files modified. Dependencies were installed from the lockfile; `node_modules/` and `dist/` are ignored.

## Executive summary

The codebase has **three confirmed high-priority consistency defects**:

1. Incremental sync commits its Changes API checkpoint before durably saving the resulting snapshot and before cleaning deleted files from the content index. A hard stop in that interval can advance the checkpoint while leaving stale or missing metadata/index state that the next incremental sync will not replay.
2. Replacing a content index deletes the previous index first, then writes the replacement in a later transaction. A failed replacement loses the last good index.
3. Removal failures are swallowed, while callers report success. This can leave stale chunks/postings/vectors and makes prune/removal counts unreliable.

There is also a confirmed stale-verification bug: an incremental update preserves a prior `sha256:` value even when the file's Drive `modifiedTime` has changed. Since the duplicate cleaner treats that SHA as verified and enables trash selection, a changed file can remain incorrectly classified as an exact duplicate.

The supplied Changes API “checkpoint skips changes after 500 pages” finding is **not accurate as stated**: at the cap, the function returns the *starting* token, not an advanced token. This prevents skipping but can pin sync to the same first 500 pages indefinitely. The distinct crash-ordering issue above is the actual checkpoint/data-loss risk.

## Confirmed findings

### P1 — Incremental checkpoint can be committed before snapshot/index effects

**Evidence:** `src/lib/syncDrive.ts:27–47` applies the changes, saves `newPageToken`, then saves the Drive snapshot, then removes deleted files from the content index. The snapshot and checkpoint are separate IndexedDB transactions in `src/lib/driveMetaStore.ts:54–76` and `:113–127`; the content index is in a separate database (`src/lib/contentIndex.ts:5–9`).

**Failure mode:** If the browser/process terminates after the token save but before the snapshot save, the next run loads the old snapshot and the advanced checkpoint. Changes in that batch are not replayed, so deleted/updated/new Drive metadata can remain stale or missing indefinitely. A stop after snapshot persistence but before index cleanup can leave stale index rows. Ordinary thrown errors later in the block do trigger fallback/clear-token logic, but that cannot handle abrupt termination between committed transactions.

**Recommendation:** Advance the durable checkpoint only after applying/persisting the corresponding state; make replay safe, or use a durable pending-batch/outbox record so recovery can finish state application before checkpoint advancement. Include index cleanup in the recovery/reconciliation strategy.

### P1 — Content-index replacement deletes the last good copy before commit

**Evidence:** `src/lib/contentIndex.ts:114–167`; `putIndexedDocument()` calls and awaits `removeIndexedDocument(doc.id)` at line 139, then starts a separate read-write transaction to insert the new document, chunks, and postings at lines 140–166.

**Failure mode:** If the new write transaction aborts (quota, storage pressure, browser shutdown, IndexedDB error), the previous document/chunks/postings have already been deleted. This is an observable search-index data loss window. The new document/chunks/postings are internally grouped in one transaction, but the replace as a whole is not atomic.

**Recommendation:** Stage/version the replacement and atomically switch the active version, or replace old and new records in one transaction that can enumerate/delete the old keys and insert the new rows before commit.

### P1 — Index deletion failures are swallowed and reported as success

**Evidence:** `src/lib/contentIndex.ts:169–192` catches failures in the document/chunk/posting deletion transaction and only logs a warning (`:184–186`); vector removal errors are also ignored (`:187–191`). `removeIndexedDocumentsByIds()` then increments its removed count unconditionally (`:221–227`), and prune similarly counts the document as removed after calling the swallowing function (`:206–216`).

**Failure mode:** Callers cannot distinguish successful cleanup from a partial/failed cleanup. Stale postings/chunks/vectors can remain; IDs reported as removed may not have been removed. Search currently intersects postings with documents when a corpus key is supplied (`contentIndex.ts:319–325`), which limits some ghost hits, but does not restore store consistency and does not protect every consumer of vectors/postings.

**Recommendation:** Propagate deletion errors or return a structured result; only advance prune/removal counters after confirmed transaction completion. Reconcile orphan rows by file ID.

### P1 — Incremental sync retains a stale verified SHA-256 after file edits

**Evidence:** `src/lib/driveChanges.ts:210–225` maps a changed file to fresh Drive metadata but, whenever the old file has a `sha256:` content hash, copies that hash to the newly mapped file (`:218–223`) without checking whether `modifiedTime` changed. SHA verification hashes downloaded/exported bytes (`src/lib/hashVerifier.ts:17–23`, `:40–46`). The duplicate engine treats a shared `sha256:` key as the primary duplicate key (`src/lib/duplicateEngine.ts:11–32`), and the UI enables trash selection for SHA groups (`src/components/DuplicateFinder.tsx:111–140`, `:253–289`).

**Failure mode:** A file verified at one revision can be edited in Drive. Incremental sync updates its name/size/modified time but preserves its old SHA. It can then continue to group with files matching the *old* content and be presented as “confirmed SHA-256,” although the edited bytes were never hashed. This can lead to an incorrect duplicate/trash decision.

**Recommendation:** Invalidate `sha256:` on any Drive content revision change (at least when `modifiedTime` changes); bind verification to a revision/modifiedTime and revalidate before destructive actions. If the file remains pinned offline, compare the remote revision against the hashed cached revision rather than preserving SHA unconditionally.

### P1/P2 — A >500-page Changes backlog stalls instead of advancing or reporting incomplete

**Evidence:** `src/lib/driveChanges.ts:92–115`, default `maxPages = 500`. `newPageToken` is initialized to the input token (`:99–101`) and changes only if a page contains `newStartPageToken` (`:105–107`). If the loop exhausts its cap first, the function returns the input token. `runDriveSync()` saves that returned token (`src/lib/syncDrive.ts:27–32`).

**Assessment of supplied claim:** The claim that this saves an advanced token and silently skips the unprocessed tail is **false for this implementation**. With no `newStartPageToken`, it saves the old starting token. Changes are therefore replayed; the first 500 pages can be reapplied on each sync and later pages may never be reached. This is a liveness/freshness defect, not the claimed checkpoint skip/data-loss defect.

**Recommendation:** Return an explicit incomplete/error state when no `newStartPageToken` was reached; continue pagination in bounded batches while persisting an intermediate cursor safely, or fall back to a full reconciliation. Do not label the capped result successful/up-to-date.

## Confirmed but not proven to create duplicates: non-idempotent POST retry policy

`createGoogleDriveFolder()` and `uploadGoogleDriveFile()` pass POST requests through `fetchWithBackoff()` (`src/lib/googleDriveService.ts:278–301`, `:349–390`). The helper retries 403 and 429 responses (`src/lib/rateLimit.ts:3–5`, `:50–68`). Repeating resource-creation POSTs is not idempotent, so retrying after an ambiguous commit could duplicate a resource.

However, the specific supplied sequence “server created the file, then response was lost as a transient network error, then this helper retried” is **not supported by current helper behavior**: a rejected `fetch()`/network exception is not caught or retried; it propagates out. The source confirms non-idempotent POST retries on 403/429, but does not demonstrate that those response statuses can follow a successful creation. Treat this as a retry-design risk, not a reproduced duplicate-file bug. Prefer operation-specific retry rules or an idempotency/resumable strategy.

## Additional supplied claims: source-level disposition

| Claim | Audit result |
|---|---|
| Blanket 403 retry is too broad | **Confirmed.** `src/lib/rateLimit.ts:3–5` treats every 403 as retryable; tests assert that behavior (`src/lib/__tests__/rateLimit.test.ts:4–10`). Google Drive 403 responses include non-rate-limit permission/policy failures. Classify by API reason/header before retrying. |
| ANN can miss true nearest neighbors when it returns any candidates | **Confirmed limitation.** `src/lib/vectorIndex.ts:546–603` exact-falls-back only when ANN returns zero hits (`:578`). Non-empty approximate candidates suppress exact scan. This is intentional approximate retrieval but not an exact-result guarantee. |
| ANN relevance test is not production-recall evidence | **Confirmed.** `src/lib/__tests__/vectorIndex.relevance.test.ts:27–29`, `:30–39`, and `:141–227` use 8 topics × 10 deterministic, deliberately separated synthetic vectors. It is a regression fixture, not live Gemini/Drive corpus evidence. Current run measured 100% fixture recall/precision, which does not establish production recall. |
| Semantic duplicate grouping has transitive chain effect; score is not all-pairs similarity | **Confirmed.** Union-find links threshold-passing pairs (`src/lib/duplicateEngine.ts:98–119`); groups can therefore contain a below-threshold pair. Reported group score is the maximum stored qualifying pair / threshold (`:129–137`), not a minimum or guarantee for every pair. The UI displays “Semantic similarity N%” (`src/components/DuplicateFinder.tsx:245–248`), which should be labeled as a group/review score rather than pairwise duplicate confidence. |
| Duplicate API does not encode candidate vs SHA-verified state | **Partly confirmed; UI mitigates it.** `DuplicateGroup` contains only `hash` (`src/types.ts:48–54`), and the engine infers grouping type from string prefixes (`src/lib/duplicateEngine.ts:15–32`, `:50–54`). But current UI also derives and displays “confirmed SHA-256” vs “candidate (size + name) — trash locked” (`src/components/DuplicateFinder.tsx:253–289`) and guards trash selection (`:111–140`). Explicit typed verification would be safer API design, but the alleged absent UI distinction is not true for current UI. |
| Hash verification necessarily downloads the whole Drive corpus | **Overstated.** The helper is sequential and downloads/exports each supplied file (`src/lib/hashVerifier.ts:26–47`; `src/lib/offlineCache.ts:255–279`), but the current Duplicate Finder passes IDs from size/name candidate groups, not every file by default (`src/components/DuplicateFinder.tsx:201–214`). Large candidate sets can still be costly; it is not inherently a full-corpus scan in this flow. |
| Native Google file SHA is over exported representation | **Confirmed.** Google Docs export as PDF, Sheets as XLSX, Presentations as PDF, and Drawings as PNG (`src/lib/offlineCache.ts:232–249`, `:261–270`); the resulting blob is SHA-256 hashed (`src/lib/hashVerifier.ts:21–23`). It is a hash of those export bytes, not an API-provided hash of native logical content. |
| Extraction coverage excludes PDF/DOCX/XLSX/PPTX/OCR | **Confirmed.** `canExtractText()` accepts text-like formats and Google Docs/Sheets/Slides only (`src/lib/contentExtract.ts:24–32`); implemented extractors likewise only export those native files or download text-like media (`:73–121`). No PDF/Office parser or OCR path appears in that module. |
| Search index stores extracted text outside the vault encryption | **Confirmed.** `IndexedDocument.text` and chunk text persist in IndexedDB (`src/lib/contentIndex.ts:15–28`, `:124–137`, `:141–163`). The vector store also persists chunk text (`src/lib/vectorIndex.ts:20–35`, `:424–438`). Vault records use a separate store (`src/lib/vaultStore.ts`), so vault encryption should not be read as encryption of the search-index databases. This is a privacy/security architecture concern rather than a consistency bug. |
| Worker rate limit is not global across Cloudflare isolates | **Confirmed implementation limitation.** A module-global in-memory `Map` is explicitly documented as per-isolate (`workers/embed/src/index.ts:28–30`); quota checks use that map (`:63–72`, `:235–238`). It is best-effort per isolate, not a durable/global account quota. |
| Authenticated Worker live contract is optional on deployment | **Confirmed.** Both `.github/workflows/deploy.yml:117–128` and `.github/workflows/deploy-worker.yml:45–57` fall back to health + unauthenticated 401 checks if test credentials are absent. The stronger Firebase→Worker→Gemini vector check is conditional. |
| Two Worker deployment workflows exist | **Confirmed.** Automatic Worker deployment is in `.github/workflows/deploy.yml:85–128`; a separately dispatchable Worker deployment is in `.github/workflows/deploy-worker.yml:1–57`. Both can deploy the same Worker and both make the authenticated gate optional, creating policy-duplication risk. |
| Both `main` and `master` can trigger production deployment | **Confirmed.** `.github/workflows/deploy.yml:4–8`, `:60–62`, `:85–88`, and `:130–151` admit both branches. |
| Lockfile workflow has an automated write path | **Confirmed on the audited baseline.** `.github/workflows/commit-lockfile.yml:5–11`, `:31–44` ran on package.json pushes to either branch, granted `contents: write`, and committed/pushed lockfile updates. This has since been replaced by a read-only consistency check. |

## Test and build validation

After installing dependencies with `npm ci --ignore-scripts --no-audit --no-fund`:

- `npm test -- --run` — **passed: 17 test files, 71 tests**.
- `npm run lint` (`tsc --noEmit`) — **passed**.
- `npm run build` — **passed**. Vite emitted a non-fatal warning that `./error-suppress.js` cannot be bundled without `type="module"`.

At the audited baseline, tests did not exercise the key failure windows found here: Changes pagination cap/checkpoint behavior, checkpoint-vs-snapshot crash ordering, content-index replacement, swallowed index deletion, or invalidation of SHA after Drive revision changes. The remediation tests below add coverage for these critical state transitions.

## Recommended fix order

1. Fix checkpoint commit/recovery semantics and distinguish incomplete sync results.
2. Invalidate/revision-bind verified SHA values on Drive changes.
3. Make document replacement atomic/versioned.
4. Stop swallowing index deletion errors; make prune/removal outcomes truthful and reconcile orphans.
5. Narrow 403 retries to actual rate-limit reasons; avoid blind retries for resource-creation POSTs.
6. Add failure-injection and pagination tests for all five paths above; then address ANN recall and semantic group labeling as search-quality work.


## Remediation status (2026-09-27)

The audited findings above describe the baseline revision `5391421`; the following changes are included in the remediation branch and supersede those findings for the updated source:

| Baseline finding / risk | Remediation |
|---|---|
| Checkpoint committed before snapshot/index effects | Incremental cleanup and snapshot persist before the Changes checkpoint. Full sync captures a baseline before enumeration and saves it only after a complete snapshot/prune. `syncDrive.test.ts` locks in both orderings. |
| Capped Changes drain could repeat forever while looking successful | `listAllDriveChanges()` now throws an explicit incomplete-pagination error unless it reaches `newStartPageToken`; the checkpoint is not returned or advanced. Regression tests cover capped and complete drains. |
| Index replacement deleted the last good row before writing replacement | Old chunk/posting keys are collected and replaced in one multi-store IndexedDB transaction; rollback preserves the old rows if the transaction aborts. Regression tests verify the replaced document, old-term removal, and new-term search. |
| Removal swallowed errors and over-reported success | Text-store removal is transactional, vector removal now propagates transaction failures, and bulk/prune counts only advance after the awaited removal succeeds. |
| Verified hash could outlive the revision it described | Hash verification and offline pinning recheck Drive `modifiedTime`; `DriveFile` and offline metadata retain the verified revision; incremental changes and offline restore invalidate mismatched hashes. Tests cover changed and unchanged revisions. |
| Generic 403 retry / ambiguous POST retries | 403 retry now requires an explicit recognized Drive rate-limit reason. Automatic backoff is limited to safe read methods; POST/mutation requests are not blindly replayed. |
| Duplicate-state inference and semantic score wording | Exact/candidate group type is exposed as typed metadata. Semantic review reports “Best pair similarity” with a direct-pair caveat rather than implying an all-pairs group score. |
| Truncation was not reliably recorded | The text extractor returns explicit truncation metadata and indexing persists it; tests cover capped and short responses. |
| Duplicate deployment workflows/optional auth gate/multiple production branches | The standalone Worker and redundant build workflows are removed. The remaining deployment workflow targets `main`, makes authenticated Worker contract credentials mandatory, and deploys Pages only after Worker verification succeeds. |
| Workflow automatically pushed lockfile changes | `.github/workflows/verify-lockfile.yml` is now read-only and fails when the committed lockfile is stale. |

**Remaining known limits:** browser storage is split across IndexedDB databases, so a single transaction cannot atomically commit BM25 and vector mutations together; failures now propagate and re-index/retry is the recovery path. ANN retrieval remains approximate and does not guarantee nearest-neighbor recall when candidate buckets return results. Native Google hashes remain hashes of export bytes. The Worker rate limiter remains isolate-local. These are disclosed in the README rather than presented as solved guarantees.

**Post-remediation local validation:** `npm test -- --run` passed **20 test files / 89 tests**; `npm run lint` (TypeScript) passed; `npm run test:idb` passed (10 tests); `npm run build` passed with the existing non-fatal `error-suppress.js` bundling warning; `npm run check:bundle` passed; both remaining workflow YAML files parsed; and the lockfile consistency check produced no `package-lock.json` diff. A truncation-counter name collision and one incorrect test expectation were caught and fixed before the final passing run.
