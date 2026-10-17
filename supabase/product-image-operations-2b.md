# Product images: recoverable operations (stage 2B)

Local implementation on top of c39d5dd / catalog stage 2A. No new SQL migration,
table/view/policy changes, deployment or remote operations are introduced.
Existing product/category contracts and the product-images bucket are preserved.

## Preparation before writes

Selecting a product image validates JPEG/PNG/WebP MIME, nonempty input and a maximum
5 MiB file. The matching header parser from image-size 2.0.4 checks dimensions
BEFORE browser decoding: maximum 4096 pixels per side and 12 million pixels total.
Browser header parsing runs in a same-origin module Worker with a three-second
deadline and unconditional termination. Unsupported/blocked Workers fail closed.
Only the JPEG, PNG and WebP parsers are loaded, not the library's other formats.

The browser decodes and rechecks actual dimensions, downsizes without upscaling
to at most 2048 pixels per side and encodes WebP at quality 0.86. The output must
be nonempty, MIME image/webp, at most 5 MiB and have a valid bounded WebP header.
Canvas backing memory is released after encoding. SHA-256 binds the prepared
bytes to the pending operation. A new UUID identifies the selection.

Invalid input/conversion failure preserves the previous valid file/prepared selection,
including its hash and selection UUID, and displays the error. Without a previous valid
selection, saving is blocked until the invalid selection is removed or replaced.
This is reasonable browser resource limiting, not a hard quota on native decoder
memory or a server-side content-security boundary. RLS still protects direct API use.
Deployments must allow same-origin module Workers in CSP; do not loosen CSP globally.

Category callers retain their original conversion defaults and 2 MiB input limit:
the new conversion limits are opt-in and applied only to products. Category bucket,
paths, upload and deletion services are unchanged. Browser regression tests verify
the shared default converter retains original category image dimensions.

## Operation / persistence

States: prepared -> uploading -> uploaded -> linking -> linked. Failures can enter
uncertain; incompatible current references/bytes enter conflict. A confirmed upload
is never automatically repeated. Each external write is preceded by durable intent.

The candidate is generated once when the prepared selection is bound to the real
product ID:

`{store_id}-{store_slug}/products/{product_id}-{product_slug}/principal-{selection_uuid}.webp`

Bucket remains product-images. Existing numeric and descriptive paths remain readable;
existing objects are never renamed. Store/product renames do not change an operation's
frozen candidate. upload uses upsert:false: upsert:true would contradict the requirement
not to overwrite existing objects. A duplicate upload receives a conflict, not an overwrite.

sessionStorage is partitioned by owner/store/product. It stores only a version, IDs,
candidate/expected relative paths, prepared byte length/hash, phase and upload flags.
It contains no binary/base64, product form payload, credentials, JWT or passwords.
Paths include existing public catalog slugs; File.name is not stored as a field.
Unexpected fields, unsafe candidate paths, URL/query-bearing expected references,
invalid sizes/hashes and wrong owner/store/product metadata fail closed. The metadata
is not authorization and is not trusted instead of RLS or remote byte verification.

Opening Editar producto reloads its pending metadata. File objects are not restored.
After an uploaded/ambiguous operation, bounded authenticated download of that exact
candidate (fresh cache nonce + no-store + timeout) verifies byte length and SHA-256.
Match allows linking; mismatched bytes cause conflict; network/auth/unknown errors
remain uncertain. No listing or broad Storage scan is used.

Only explicit NoSuchKey/404 is classified absent. Even that may mask permissions or
precede a timed-out request committing late. Once upload intent has been persisted,
absence NEVER authorizes another upload, even after refresh or file re-selection.
Retry only verifies the SAME candidate and links it if its bytes match. A late upload
can thus recover safely without another POST. A missing candidate stays uncertain;
the client has no trustworthy proof that the earlier server operation has stopped.
The user can explicitly discard the pending change, retaining any old/candidate files,
before starting a new selection. upsert:false remains unchanged and prevents overwrite.

If bytes are unavailable, re-selecting the same file must reproduce the recorded
prepared hash/size; otherwise discard the pending change explicitly before selecting
another. Retry only runs the image operation, not product creation or metadata UPDATE.
The stage 2A product ID is retained before starting any image operation.

Closing the form drops in-memory file data but not durable pending metadata.
Discard removes ONLY the local metadata, never the old/candidate Storage file or
the database reference. An ambiguous link may already have committed: discarding
does not undo it. Reopen/reload the product to see the authoritative current image.

## Atomic linking without an RPC

products.ts sends ONE PostgREST UPDATE of image_path, filtered by store_id, id and
the expected previous image_path (`is.null` or `eq.<old>`). Existing authenticated
owner RLS applies to that statement; no service key or SECURITY DEFINER bypass exists.

PostgreSQL locks the row and rechecks the WHERE predicate against a concurrent
winner's committed row under READ COMMITTED. This is not a GET followed by an
unconditional UPDATE. The preflight read reduces needless uploads but is not the
concurrency guarantee. No new RPC/migration is necessary for pointer compare-and-set.

When the UPDATE returns no row or its response is lost/aborted, a store/id-scoped read
classifies: candidate already present => linked; a different value than expected =>
conflict; expected value still present / unavailable read => uncertain. There is no
automatic second UPDATE in that call. Retry rereads before deciding. UI and coordinator
guards reject double execution; separate sessions rely on the database predicate.

This compares the CURRENT value, not a version counter: ABA changes (old -> other ->
old) are not detected. Product metadata edits still have their prior last-writer-wins
semantics. PostgreSQL and Storage do not share a transaction. Another privileged or
legacy writer could replace/delete an object after verification; no global immutable
object policy is introduced here. Verify effective remote policies separately.

## No deletion / shared references

Old images are retained until and AFTER a replacement is linked. No product image
remove/move API is called. Candidates from failed/abandoned operations are also kept.
No claim is made that an old image is unreferenced: other products/tenants, other
entities or rollback records may refer to it, and RLS can hide those references.
An eventual garbage collector needs separately reviewed global reference checks
AND coordination with writers, not a frontend check-then-delete race.

## Local tests

```sh
npm run test:products:images:unit
npm run test:products:images:sql
npm run test:products:images:browser
npm run test:products:images:typecheck
npm run test:products:creation:unit
npm run test:products:creation:sql
npx tsc -b
npm run build
npm run lint
git diff --check
```

- Unit tests inject image I/O doubles, explicitly testing phases, retry identity,
  uncertainty, conflict, double click, metadata isolation and retention of old files.
- SQL tests use a disposable PostgreSQL cluster with TCP disabled, private Unix
  socket and PG* connection overrides removed. They require tools (no skips), use
  the actual catalog RLS/migrations and test real concurrent conditional updates,
  NULL, legacy/shared references, unauthorized users and stage 2A compatibility.
- Playwright runs the actual React form, Supabase JS SDK, header Worker and native
  browser decoder/canvas. HTTP endpoints are intercepted with an in-memory protocol
  fixture; these are NOT tests of a real Storage server. All external requests are
  blocked and counted. The dedicated Vite config disables .env loading and injects
  a loopback URL and dummy public key; it never loads a real Supabase project config.
  Tests include zero writes on invalid/conversion failure, lost responses, failed
  linking, refresh with/without bytes, late upload recovery, preservation of a valid
  selection after invalid replacement, images.begin persistence failure after product
  creation, and 2A double submission.
  Mobile/desktop screenshots and overflow checks are local ignored artifacts.

image-size is the zero-transitive-dependency runtime header parser. Playwright is a
dev-only dependency; tests use installed Chrome on macOS or PRODUCT_IMAGES_BROWSER.
On other systems install Playwright's local Chromium separately. SQL tests prefer
Homebrew PostgreSQL 16 or CATALOG_PG_BIN, as in stage 2A. No remote tests run.

## Residual risks / manual checks before rollout

- sessionStorage survives refresh in the same tab, not tab closure/site-data removal,
  another device or all private-browsing restrictions. Lost metadata and abandoned
  uploads can leave orphans; no automatic deletion or durable server operation log.
- Different browsers/encoder versions may not reproduce identical prepared WebP
  bytes; do not accept a different hash as the old candidate. Discarding is explicit.
- In-memory image blobs live only for the current form. Storage/persistence failures
  leave pending work, never a fallback overwrite or another product INSERT.
- Remote Auth, RLS, bucket limits, access policies, cache behavior and deployment CSP
  must be checked independently. Local tests do not certify the current remote setup.
- A provider ACK is trusted as upload confirmation. Before resuming a confirmed upload
  after an error/refresh, bytes are reverified; future external edits remain possible.
- No Payments/Commerce changes, SQL migration, payment flags, remote upload, deletion,
  deploy, publication, commit or push are performed by this stage.

References reviewed for the design:
- [Supabase uploads](https://supabase.com/docs/guides/storage/uploads/standard-uploads)
- [Storage error codes](https://supabase.com/docs/guides/storage/debugging/error-codes)
- [PostgreSQL isolation](https://www.postgresql.org/docs/16/transaction-iso.html)
- [Canvas toBlob](https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/toBlob)
- [image-size](https://github.com/image-size/image-size) (maintainer points to Codeberg)
