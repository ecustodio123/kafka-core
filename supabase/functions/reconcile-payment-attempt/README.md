# Administrative TEST charge diagnostics

Read-only diagnostic endpoint. Not a checkout endpoint, not a reconciliation
writer, and not evidence that a charge should be finalized automatically.
No deployment, SQL changes or provider calls are required for local unit tests.

## Configuration (backend only)

- `RECONCILE_PAYMENT_ATTEMPT_DIAGNOSTIC_ENABLED`: disabled unless exactly `true`.
  Independent of all online-payment flags; enabling diagnostics does not enable charges.
- `RECONCILE_PAYMENT_ATTEMPT_ALLOWED_ORIGINS`: explicit comma-separated Admin origins.
  No wildcard. Origin-less administrative clients still require an owner access token.
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`: existing server secrets only.

The request must carry `Authorization: Bearer <owner Supabase Auth access token>`.
Use the Admin's existing authenticated session, not a CLI personal access token,
service-role JWT, checkout session token or browser-supplied owner identity.
`verify_jwt=false` delegates verification to `auth.getUser(token)` in the handler
(compatible with Auth signing keys); it does not make the endpoint unauthenticated.
Anonymous Auth users are rejected. Ownership is checked against `stores.owner_user_id`
before reading attempts or accessing Vault. Reads always filter by the authorized store.

## Input and output

POST JSON (maximum 1 KiB, no extra fields):

```json
{"store_id": 1, "payment_attempt_id": "cccccccc-cccc-4ccc-8ccc-cccccccccccc"}
```

No caller-supplied charge ID, order amount, private key, secret ID or provider URL.
Uses only `payment_attempts.culqi_charge_id` and validates the persisted order amount.
Requires provider `culqi`, environment `test`, currency `PEN`.

Successful diagnostic responses (HTTP 200) include only:

- `diagnostic_only: true`, `state_modified: false`, `environment: "test"`;
- authorized `store_id`, `order_id`, `payment_attempt_id`;
- `financial_state: "not_determined"` (always; NOT a paid/failed decision);
- `result`: `found_compatible`, `found_incompatible`, or `uncertain`;
- matching evidence label and allowlisted provider observations, or fixed reason,
  mismatch/missing field names. Never raw provider values for mismatches.

`found_compatible` means ID, object, original amount, PEN and all three Kafka metadata
references match. It does NOT prove capture, settlement, absence of refunds, 3DS
authentication or an appropriate local terminal transition. Observations expose only
typed `capture`, `capture_date`, `paid`, `dispute`, `amount_refunded_cents`; absent or
malformed optional observations are null. Raw cards/sources, emails, authentication
data, tokens and messages are never returned or logged. Responses use `no-store`.

Errors: 400 invalid input, 401 invalid/missing Auth token, 403 disallowed Origin,
404 unavailable/unowned resource, 409 incompatible local data/reference,
503 disabled/configuration/database failure. Provider 404/429/5xx, timeouts,
network errors and malformed responses produce an `uncertain` diagnostic, not a
failed payment. One GET maximum per request, five-second timeout, no retries,
64 KiB streamed response limit, redirects rejected, fixed official HTTPS destination.

## Missing charge ID and future recovery

No ID means `uncertain / missing_charge_id_manual_review_required`. No list call,
metadata search or credential lookup is performed. Never resend a charge.
Conservative future workflow: an owner investigates the exact store/account and
narrow creation-time interval in CulqiPanel; a candidate needs exact amount/PEN
and Kafka store/order/attempt metadata. Any future API search must use server-derived
time filters, strict page/record/time budgets and reject zero/multiple/partial matches
as uncertain. No broad scanning or client-selected candidate lookup is implemented here.
Neither a 404 nor an empty list proves that a charge did not occur.

## Official contract and limitations

- [Retrieve charge](https://apidocs.culqi.com/#tag/Cargos/operation/consultar-cargo):
  `GET https://api.culqi.com/v2/charges/{id}`, private Bearer key, HTTP 200 means
  successful retrieval. The current documentation specifies 25-character IDs
  (`chr_test_` + 16 alphanumerics). Existing charge callers accept variable-length
  alphanumeric suffixes; migration 013 bounds safe references at 160 total characters.
  Diagnostics therefore accept `chr_test_` + 1..151 ASCII alphanumerics. This is a
  local compatibility bound, NOT evidence that Culqi issues every permitted length.
  The exact persisted ID must still match the retrieved object and Kafka metadata.
  Reject LIVE prefixes, empty/oversized suffixes, MOCK IDs with underscores, whitespace,
  Unicode, URLs, slashes, dot segments, percent encoding, query strings and fragments.
- [Charge metadata](https://docs.culqi.com/es/documentacion/pagos-online/cargo-unico/cargos/):
  merchant-supplied business linkage, not provider authentication evidence.
- [Capture](https://docs.culqi.com/es/documentacion/pagos-online/cargo-unico/captura/):
  authorization and capture differ. The API examples include `capture=true` with
  `paid=false`; the documentation's description of `paid` is inconsistent. Do not
  infer a paid order from HTTP 200 or that field alone. No independent 3DS proof here.

Existing Vault RPC 007 requires active/enabled TEST settings and a valid named per-store
secret. Diagnostics will fail closed if those settings are disabled or keys rotated
to a different merchant. No global credential fallback and no changes to that RPC.
Matching all metadata is deliberately conservative; historical charges without it
remain uncertain. A charge read and local reads are not one distributed snapshot;
any later writer MUST re-read/lock and verify evidence before changing financial state.

## Local verification

```sh
npm run test:reconcile-payment-attempt:unit
npm run build
npm run lint
git diff --check
```

Unit tests inject Supabase Auth, database/Vault and HTTP doubles. They require no
credentials and no network permission to call Culqi or the Supabase project.

## Mandatory prerequisite before enabling diagnostics

Keep `RECONCILE_PAYMENT_ATTEMPT_DIAGNOSTIC_ENABLED` absent or `false` until a shared
rate limiter is installed and verified. The function defaults to disabled; this
phase does not provision a limiter or claim that repeated authorized requests are
rate-limited when an operator explicitly enables it. Existing online-payment flags
do not enable diagnostics. No remote configuration has been changed or inspected.

A per-process Map, cooldown or in-flight lock is not a reliable limit: Edge Function
isolates restart and run concurrently. CORS, one GET per request and the five-second
timeout do not bound aggregate usage. No such misleading local limiter is added.

Minimal future option: shared gateway/KV quota with server-verified owner identity
and ownership, or a new private quota RPC/table in a separately reviewed migration.
The latter would add writes/infrastructure outside this read-only phase; no historical
migration is modified. Requirements for that follow-up:

- Atomic quotas on BOTH authenticated owner ID and authorized store ID, shared
  across instances (initial administrative budget proposal: 10 requests/minute per
  owner AND 10/minute per store, burst 2; tune before rollout).
- Optional owner/store/attempt cooldown to avoid repeated manual polling; no automatic
  provider retries or background searches. No customer-facing polling UI.
- Consume quota before Vault/provider access. Over quota returns 429 with Retry-After;
  limiter outage fails closed with 503, without a provider call. Never key quotas by
  unverified client owner headers, arbitrary store IDs or rotating JWT strings.
- Protect Auth verification itself with a coarse gateway/IP limit, separate from the
  authenticated tenant quotas. An IP limit alone is not the owner/store guarantee.
- Test concurrent calls across at least two instances, owner/store isolation, window
  reset, unavailable limiter, 429/503 responses and zero provider calls when blocked.
- Prevent bypass: a gateway-only solution must also restrict direct access to the Edge
  Function or enforce the same shared limiter inside it, using a reviewed trust boundary.

After that: owner-only access review, limited administrative rollout and monitoring
without tokens, keys or raw provider data. This phase adds no durable audit log;
authenticated repeated GETs can incur API costs if the flag is enabled prematurely.
