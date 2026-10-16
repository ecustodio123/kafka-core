# Atomic session authorization and claim (016)

Local implementation only. Review/apply 016 manually after 001-015 and before
deploying the updated real-payment handlers. No flags, provider requests or
remote migrations are executed by this change. MOCK and Commerce are unchanged.

## Service contracts

`claim_payment_attempt_for_session(p_store_id bigint, p_order_id uuid,
p_payment_attempt_id uuid, p_token_hash text, p_idempotency_key text,
p_culqi_source_id text)` authorizes the initial claim.

`claim_payment_3ds_for_session(p_store_id bigint, p_order_id uuid,
p_payment_attempt_id uuid, p_token_hash text, p_culqi_source_id text,
p_device_fingerprint_id text)` authorizes continuation of the original attempt.
3DS keeps the original persisted idempotency key; no new reservation/key is made.
Both compare the exact JSONB/SHA-256 source fingerprint used by migration 006.

Both RPCs are SECURITY DEFINER, search_path='', service_role-only. Their common
implementation `kafka_claim_for_payment_session` is owner-only: PUBLIC, anon,
authenticated AND service_role cannot execute the helper directly. All references
outside pg_catalog are schema-qualified. No owner or global table permissions
are changed. The existing claims remain service-only primitives for compatibility
and private MOCK; neither real handler calls them directly anymore.

Inputs are server RPC arguments, not URL parameters. The original payment session
token is hashed by the Edge Function and is never passed to SQL. The source and
device are transient inputs only: neither they, their hashes, tokens nor keys are
added to events, logs or responses. Do not enable request-body/argument logging
for payment endpoints in infrastructure outside this repository.

## Transaction and response

1. Lock the scoped order, scoped attempt, then matching session FOR UPDATE.
2. Capture clock_timestamp() after all locks; require active, revoked_at IS NULL,
   and expires_at later than this timestamp. The 24-hour status recovery window
   does NOT authorize any claim.
3. Validate matching tenant/order/attempt, Culqi TEST/PEN, positive matching amount,
   initial key and original source fingerprint. 3DS also validates the original
   device hash and requires processing + requires_3ds + three_ds_status=required.
4. Refuse reconciliation_required before any NEW claim. Existing processing,
   terminal and completion_processing states never authorize another POST.
5. Delegate to 015/011 inside the same transaction. Those calls reacquire only
   already-held locks. Existing exclusive transitions and events remain unchanged.

Authorized responses retain acquired/reason/payment_attempt with authorized=true.
Invalid session/identity lookup returns only:
`{authorized:false, acquired:false, reason:"invalid_session"}`. No attempt details
are exposed. Configuration/identity inconsistencies use static errors. The callers
require authorized === true AND acquired === true, never truthiness.

Denied authorization performs no updates, usage increments or audit insertions.
It deliberately does not mark expiry: status queries/010 already have that lifecycle.
The earlier reservation RPC is a separate committed transaction; its created
reservation/usage may remain after a later denied claim. It is never processed
without fresh authorization. 010 and Vault lookup remain before the new claim;
3DS preflight/source checks are defense in depth, not the final authorization.

## Lock-order review

- 015, 011 3DS claim, 012's read-only validator, 013 finalize/uncertainty:
  writers lock orders before attempts; 012 takes no row/advisory locks.
- 010 locks orders -> session -> reservation advisory lock -> attempts.
  Its same-order writers cannot overlap the new order-first transaction.
- 009 revocation and 011 status lock orders before sessions. Status then reads
  attempts without FOR UPDATE. 016 revocation preserves that order.
- The new claims never call reserve or acquire its advisory lock, never lock
  another order, and delegate only after the same order/attempt are locked.
  Thus they introduce no inverse attempt -> order/advisory acquisition path.

## Revocation semantics

016 preserves revoke_order_payment_sessions(bigint,uuid), its store scope, return
shape and service_role-only access. The original RPC has no authenticated-owner
entry point: trusted backend callers must authorize any administrative request.
Revocation now covers active sessions and expired sessions still eligible for
24-hour minimal-status recovery. Already-revoked/used or older expired sessions
are not reactivated or changed. Post-revocation status recovery is rejected.

Revocation confirmed before the claim wins the order lock prevents acquisition.
If the claim wins and commits first, a later revocation cannot cancel an already
authorized/in-flight POST. The authorization linearization point is the check
under locks, not response arrival at the browser or the provider. Expiration
after that point does not cancel the claim. Database and provider are not one
transaction; never release/retry on a lost claim response, timeout or ambiguous
provider result. Keep processing/reconciliation and use verified reconciliation.

The change does not assert capture/3DS authentication evidence, enable paid
finalization, or alter conservative HTTP 200/201 classification. Provider contract
confirmation, rate limiting and future financial reconciliation remain separate.

## Validation

`npm run test:payments:session-claim:sql` creates a disposable private Unix-socket
PostgreSQL cluster with no TCP listener, filters PG* environment overrides, uses
Vault/schema stubs and applies actual required payment migrations locally only.
It tests real parallel initial/3DS claims, reserve interleaving, revocation before
and after claim, expiry while blocked, failed authorization without side effects,
terminal/reconciliation behavior, source/device conflicts, tenant isolation,
expired-session recovery revocation, execution ACLs and safe reapplication.
Missing PostgreSQL tools produce an explicit skip, not a successful validation.

`npx -y deno@latest test --no-lock --allow-env supabase/functions` tests both HTTP
handlers with injected HTTP/DB doubles. No Culqi or Supabase remote access is used.
Apply 016 before deploying these callers; do not enable payment flags as part of
that deployment. The legacy service-role primitives remain a privileged trust
boundary, not a database-wide prohibition on bypass by other privileged code.
