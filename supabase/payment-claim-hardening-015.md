# Processing claim hardening (015)

Review `migrations/202610130015_harden_payment_attempt_processing_claim.sql`
after migrations 001-014. Do not apply automatically. It replaces only
`claim_kafka_payment_attempt_processing(bigint, uuid)`, keeping its JSONB contract,
SECURITY DEFINER, empty search_path and service_role-only EXECUTE.

Under orders -> payment_attempts row locks, processing/terminal responses remain
unchanged. A created attempt with reconciliation_required=true returns
acquired=false, reason=reconciliation_required, and the original base attempt
response. It changes no row and emits no event. The flag is intentionally NOT
added to the response helper: the refusal is authoritative even when the caller
cannot see it. A normal created reservation can still be claimed exactly once.
Applying/reapplying this function definition does not modify existing records.

The local created-recovery caller requires acquired === true before provider work.
Deploying that recovery without 015 would NOT enforce this flag in PostgreSQL.
Keep payments disabled; this task performs no deployment or remote migration.

## Local validation

`npm run test:payments:claim-hardening:sql` starts a disposable PostgreSQL cluster
in a private temporary directory, using only a Unix socket (no TCP listener).
It strips PG* environment overrides and uses a Vault FK stub, never real secrets.
It loads the actual payment migrations needed by the claim and reservation RPCs.
Tests cover read-only refusal, terminal behavior, ACL, response shape, replay through
010/006, simultaneous claims and changes committed while another claim waits.
If PostgreSQL tools are missing, the runner explicitly skips; this is not a pass.

`npx -y deno@latest test --no-lock --allow-env supabase/functions` uses HTTP/DB
doubles only. Reserve and claim responses omit the 3DS/reconciliation fields absent
from kafka_payment_attempt_response. RPC 011/013 results include their respective
additive metadata. No provider requests or shared Supabase connections are made.

## Session race (unchanged)

010 validates the session and reserves within one transaction. Vault lookup and
claim are later calls. Expiration/revocation after reservation commits does not
cancel that reservation; 015 deliberately does not change this existing policy.
It prevents duplicate acquisition, not post-reservation revocation bypass in a
strict "valid at claim time" authorization model.

A separate reviewed change could introduce a service-only combined session+claim
RPC, accepting token hash and store/order/attempt IDs. It would lock orders first,
then attempts/sessions consistently, revalidate active status and expiration under
lock, and claim only within that transaction. The legacy claim must then be gated
or retired for public checkout callers. Define separately whether revocation after
a successful claim cancels anything: a provider request may already be in flight.
Never release processing or resend automatically on timeout.
