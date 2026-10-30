# Product image stability and local diagnostics

This hardening addresses verified defects F1–F7. The cause of the reported customer white screens remains unconfirmed. No Supabase schema, policies, uploads, references, deletion or financial contracts change.

## Recovery

The product module has its own React Error Boundary; the application has a final boundary. A render failure displays a generic accessible recovery action, remounts only the affected subtree when retried, and leaves persisted drafts untouched. The product list then offers draft recovery. Boundaries cannot catch all async errors or an OS/browser process termination.

Product draft storage acquisition and operations are guarded. If the native getter, reads, writes or removal fail, drafts degrade to component-local memory with a persistent independent warning. **Memory-only drafts do not survive reload, navigation or a render failure.** No claim of durable recovery is made in this state. Creation and image-operation receipts do not degrade to memory: they still fail closed before an external write if persistence cannot be established. Existing confirmed products remain editable. No automatic upload retry or UUID replacement is introduced.

Image cancellation, timeout or invalid replacement preserves previously selected valid bytes and existing image references. A fresh file can be selected, including the same file. Preparation has an explicit cancel button. A newer selection aborts the older selection; unmount (including module/store/user changes) aborts preparation. Late results cannot update the form or initiate writes. An already-started upload is a different operation: its ambiguity and durable recovery protocol are unchanged.

## Budgets and cancellation

- Original formats remain JPG/PNG/WebP; max original 60 MiB, 16,384 px/side and 64 million pixels. Output remains max 1,200 px, WebP 0.80, with 0.70/1,000 px and 0.60/800 px retries. Final size limits remain 5 MiB products and 2 MiB other upload consumers.
- Header reads are capped at **1 MiB**, using a sliced Blob and abortable FileReader in browsers, rather than reading the full original. A valid JPEG with unusually large metadata before its dimensions may now be rejected safely: choose an exported copy with reduced metadata. No full-file fallback occurs.
- Read: 5 s per read; header worker: 3 s; bitmap decode worker: 15 s; bounded HTML image fallback: 8 s; Canvas encoding: 10 s; complete optimization: 45 s. Final optimized-byte read and SHA-256 are each bounded by 5 s. Timers are active-execution deadlines; browsers may suspend timers while backgrounded.
- Abort/timeout terminates owned Workers, aborts a pending FileReader, clears fallback handlers/source and revokes object URLs. Bitmap and Canvas cleanup also covers allocation failures. Rejected/late completions are ignored and pending waits settle once.
- Native Canvas encoding and WebCrypto do not expose abort APIs. The output Canvas is at most 1,200 × 1,200, released on failure, and no retry chain continues after cancellation; native code may finish its bounded work later. A timeout does not guarantee instantaneous reclamation by the browser.
- Large-image decoding remains delegated to a resize-capable Worker, with no unsafe full-resolution HTML fallback above 4,096 px/side or 12 MP. A resized bitmap does **not** prove a universal bound on codec peak memory. Original 64 MP compatibility is preserved; mobile OOM risk cannot be eliminated or inferred from a marker alone. Actual Android/iOS/Safari validation remains necessary.

Shared image-processing helpers retain backward-compatible defaults for categories/services/staff. Their callers, Storage and module behavior are not refactored.

## Local-only diagnostic contract

One scoped key `kafka.image-diagnostic.{userId}.{storeId}` contains at most 16 allowlisted records, each with only a random technical `id`, allowlisted `stage`, and millisecond `at` timestamp. Stages: selected, validated, read, decoded, converted, hashed, upload_started, upload_completed, associated, failed, canceled and interrupted_unknown. Upload stages observe existing coordinator transitions; they do not alter upload behavior. `selected` may be repeated by the shared pipeline.

Records older than 24 hours are ignored/pruned when that scope is next accessed or written. This is not a guaranteed background deletion timer. Access/parse/quota failures are non-fatal. The last unfinished stage is classified once as `interrupted_unknown` when that scope mounts again. Successful preparation (`hashed`) is not classified as an unexpected interruption simply because the user has not saved yet. Known cancellation is distinct from an unexplained interruption. No OOM claim is made.

Only fixed error categories and technical identifiers are logged by application diagnostics. No filename, source/image bytes, product fields, private URL, auth token, credential or raw exception is recorded. React root caught-error logging is suppressed in favor of the boundary's fixed category.

There is **no receiver, new table, third-party SDK, remote logging or automatic report collection**. Local records can help a later authorized support/export workflow, but Kafka Tech cannot retrieve them centrally today. Before centralized monitoring: define an authenticated tenant-scoped receiver, rate limits, allowlist/privacy tests, retention/deletion policy and deployment-version correlation. Session replay and raw network payload collection should remain off.

## Local validation

Unit tests: `node --test scripts/image-stability.unit.test.mjs scripts/product-images.unit.test.mjs scripts/product-creation.unit.test.mjs scripts/product-drafts.unit.test.mjs`.

Browser regressions: `npm run test:products:images:browser`. HTTP is intercepted locally, including Storage. The harness includes navigation/store changes for cancellation, and fault injection for render, storage, reads, decode, Canvas, stalled operations and resource cleanup. Existing tests retain unique candidates, upsert:false, verification, conditional linking, late uploads, no ambiguous resend, idempotent creation and category/content image preparation.

Then `npm run test:products:images:typecheck`, `npx tsc -b`, `npm run lint`, `npm run build`, `git diff --check`. No remote operations are needed.

## Compatibility hotfix and UI incidents

`Array.prototype.at` is no longer required by diagnostics. Product form scrolling checks optional APIs and catches both option/method failures; missing `matchMedia` defaults to immediate scrolling and missing scrolling becomes a no-op. No globals are polyfilled. A local compatibility helper uses secure `getRandomValues` UUID v4 when `randomUUID` is unavailable. Request deadlines use a cleared timer and `AbortController` rather than `AbortSignal.timeout`. Cryptographic hashes still require WebCrypto and image cancellation still requires AbortController; absent essential capabilities fail clearly, before unsafe writes. The catalog-deletion helper only changes UUID generation, not permissions, deletion or cleanup behavior.

The same `imageDiagnostics` module now records UI incidents. Its scope is owned above the product subtree so the boundary can obtain the last non-cancellation image stage even after editor teardown. Image context is explicitly `context_only`: no attribution of the UI error to an image, memory or Storage is made.

Each boundary failure gets a `KC-{UUID}` code, using a non-security `KC-LOCAL-{timestamp}-{counter}` fallback if secure ID generation is unavailable. This fallback is a local troubleshooting label, not a globally guaranteed identifier or an authorization token. One sanitized report is retained per scope at `{existing-image-diagnostic-key}.incidents` (root reports use `kafka.image-diagnostic.app.incidents`); the boundary also retains its current report in memory. It is replaced on the next incident in that scope and sessionStorage may disappear with the browsing session. There is no remote receiver; a code cannot be looked up by support remotely today. No automatic reports are sent.

Reports contain an ID, time, module, deployment commit if known, allowlisted error category and normalized message, at most eight known component names and six own hashed-asset line/column frames, browser major/family, OS family and optional last image context. Raw error objects, raw messages/stacks, filenames, product fields, source URLs, origins, query strings and credentials are never persisted or logged. Error property reads are bounded to 4,096 characters and guarded, and frames accept only the application's known hashed bundle name patterns. Arbitrary/unknown frames are discarded. Unknown messages become a fixed category message. Debug source paths are not collected. Safely retained numeric bundle positions require matching private source maps/artifacts for reliable source interpretation.

`main.tsx` and the boundary use one per-boundary reporter: React's caught-error hook forwards to the same instance, and `componentDidCatch` reuses the report. This avoids both raw default logging and duplicated reports. A new manual retry creates a new incident if it fails. Throwing reporters fall back to the shared sanitized writer; unavailable storage/console cannot throw out of reporting.

Retry remounts the affected subtree without deleting persisted drafts. After two failed manual retries the retry button is removed; the surrounding Admin navigation remains usable. The product boundary also offers navigation to another authorized module, and the root boundary has a plain link to the application home. No automatic retry/reload loop exists. Memory-only drafts cannot survive a subtree remount; the storage warning remains relevant.

Production build identity is injected from a validated hexadecimal `CF_PAGES_COMMIT_SHA` when available. No new remote setting is required; other environments report `unknown`. The test build uses a fixed non-secret fixture ID. No public source maps are enabled. Before deployment, review the diff and validate the build on real Android over HTTPS. Before central monitoring, separately authorize a tenant-isolated receiver and private source-map/retention strategy. The cause of the original customer incident remains unconfirmed.

Hotfix files for review (20):
- `src/App.tsx`, `src/main.tsx`, `src/components/RecoveryBoundary.tsx`.
- `src/features/products/ProductsPage.tsx`, `src/features/products/productDraft.ts`.
- `src/services/imageDiagnostics.ts`, `src/services/productCompatibility.ts`, `src/services/imageProcessing.ts`, `src/services/imageTask.ts`.
- `src/services/productCreation.ts`, `src/services/productImagePreparation.ts`, `src/services/productImages.ts`, `src/services/products.ts`, `src/services/catalogDeletion.ts`.
- `vite.config.ts`, `tests/product-images/vite.config.ts`, `tests/product-images/harness.tsx`, `tests/product-images/product-images.spec.ts`.
- `scripts/image-stability.unit.test.mjs`, this document.
