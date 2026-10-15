# Migration 014: blocked reconciliation infrastructure

Local implementation only. Do not apply remotely or deploy as part of this phase.
Migrations 001-013, Edge Functions, financial policies and flags are unchanged.

## Minimal design

No new tables, indexes or enums: reuse payment_events and its existing unique
(store_id, environment, provider, provider_event_id) constraint. Two service-role-only
RPCs provide an opaque snapshot and a transactional preparation/audit operation.
The migration itself only creates/replaces these new functions and their ACLs;
applying or reapplying it does not modify any existing records.

1. `get_kafka_payment_reconciliation_snapshot(p_store_id bigint, p_order_id uuid,
   p_payment_attempt_id uuid)` returns matching TEST/PEN context and `snapshot_hash`,
   or null for missing/incompatible scope. It uses one joined statement snapshot.
2. `prepare_kafka_payment_reconciliation(p_store_id bigint, p_order_id uuid,
   p_payment_attempt_id uuid, p_idempotency_key uuid, p_expected_snapshot_hash text,
   p_evidence jsonb)` validates scope, amounts, stored references, current states and
   the expected snapshot, then inserts one preparation event. It never calls finalize.

Both use SECURITY DEFINER, empty search_path, UTC and EXECUTE only for service_role;
PUBLIC, anon and authenticated are revoked. The future administrative Edge Function
must independently verify the owner, never proxy arbitrary public RPC parameters.
No new Edge Function or caller integration exists in this phase.

The opaque hash covers full order/attempt rows, including flags, references, 3DS
claims and timestamps. Customer fields and idempotency/source hashes are included
only in the private digest preimage: they are not returned or written to audit.
It is NOT a payment session, provider signature or financial confirmation.
UTC avoids timezone-dependent serialization; these RPCs are VOLATILE so a request
waiting for locks rechecks a fresh database snapshot after concurrent commits.
Do not recreate the hash in JavaScript. Get a fresh snapshot and retain its exact
hash for the operation; row changes require fresh analysis and a NEW internal key.

## Identity evidence v1

Only this allowlist is accepted, bounded to 4 KiB. Unknown fields, source IDs,
authentication data, arbitrary flags/verdicts and raw provider responses are rejected.

```json
{
  "schema_version": 1,
  "provider": "culqi",
  "environment": "test",
  "charge_id": "chr_test_1234567890abcdef",
  "amount_cents": 1299,
  "currency": "PEN",
  "metadata": {
    "kafka_store_id": "1",
    "kafka_order_id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    "kafka_payment_attempt_id": "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
  }
}
```

Expected values come from persisted rows; metadata must match the three RPC IDs.
The TEST reference is bounded at 160 characters and must match ALL nonnull persisted
culqi_charge_id/provider_reference values. A sole safe provider_reference may be a
candidate, but it is never attached as a charge ID. No reference means rejection;
no search, Vault lookup or assumption of payment failure. Different references require
manual review; do not silently discard one to make evidence appear compatible.

No capture/paid/3DS verdict is accepted. PostgreSQL only verifies structure and local
consistency; it cannot authenticate a Culqi HTTP response. This v1 record is NOT the
future verified financial evidence contract and does not replace the shared verifier.
That verifier still has canFinalizePaid=false and remains unintegrated.

## Locks, receipts and replays

- Acquire orders first, then the exact store/order/attempt row, matching 008/011/013.
  No advisory/session locks, locks on other orders, or HTTP while locks are held.
- An internal UUID key maps to `kafka-reconcile-v1:<uuid>` in provider_event_id.
  Canonical JSONB request text (IDs, expected snapshot and identity evidence) is hashed.
  Persist only allowlisted identity evidence, fingerprint, fixed action and receipt.
  The internal namespace is not a real Culqi event and must not be used by other writers.
- Same key/request returns the ORIGINAL receipt, even after later finalization.
  It is explicitly a historical preparation result, never a current-state response or
  fresh authorization. Changing snapshot, evidence or attempt with that key conflicts.
  Key uniqueness is tenant/environment/provider-scoped. New checks need new keys.
- Existing-row locks serialize same-order operations. The event unique index also
  handles the same key used concurrently across different orders: one insert wins,
  the other verifies the fingerprint and fails safely. No broad unique_violation
  handler rolls back acquired locks. Non-idempotent new requests reject stale snapshots.
- Financial/3DS consistency checks reject contradictory paid histories, but preserve
  legitimate historical created/processing/failed attempts on a paid order.

The only successful response is a nonfinancial preparation receipt:

```json
{
  "result": "not_applied",
  "reason": "pending_provider_confirmation",
  "financial_transitions_enabled": false,
  "financial_state_modified": false,
  "store_id": 1,
  "order_id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  "payment_attempt_id": "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
}
```

There is an audit INSERT, not a fully read-only RPC. Orders, attempts, claims,
reconciliation_required/reason, paid_at and 3DS timestamps are never changed.
Terminal/processing states remain identical. No paid/failed parameter or enable flag
exists. Valid 3DS requests may be recorded as preparation; this never acquires,
releases, retries or authorizes their claims.

### Audit event semantics

The existing event_type enum contains only provider_request, provider_response,
webhook_received, webhook_verified, status_changed and error. None denotes a
successful internal preparation: no provider request/webhook is made here, no status
changes, and preparation is not an error. Keep provider_response for compatibility,
without adding or modifying any enum. It is a storage classification, NOT proof of
a provider response, captured payment, verified financial evidence or 3DS outcome.

Every preparation event explicitly contains these server-generated fields:

```json
{
  "action": "prepare_reconciliation_v1",
  "event_origin": "internal_reconciliation_preparation",
  "financial_evidence_verified": false
}
```

Consumers must inspect the action/origin, not infer verification from event_type.
The identity_evidence field is only structurally checked caller input. These audit
markers do not change request fingerprints, idempotency keys, snapshots, receipts,
permissions or lock order. Duplicate requests still reuse the original receipt/event.

## Before any financial application

- Confirm Culqi's precise capture evidence, paid/capture_date semantics, operations,
  refunds/disputes and per-account credential provenance. Define freshness rules;
  this snapshot detects LOCAL changes, not stale provider data or an old HTTP read.
- Add the shared verifier's independently reviewed verified branch and integrate both
  paid callers. Never turn this preparation receipt into a capture certificate.
- Version/extend the application protocol separately (do not retroactively apply an
  old not_applied receipt). Bind freshly verified evidence to current state atomically,
  reuse safe finalization rules, and preserve independent 3DS review requirements.
- Reassess in-flight work: SQL locks cannot cancel an HTTP request after a claim.
  Diagnostic preparation may race safely because it does not write financial state;
  a future financial writer needs stricter exclusions/coordination for active 3DS.
- Establish rotated/historical account handling, restricted owner authorization,
  distributed quotas before enabling any endpoint, bounded recovery of missing IDs,
  and audit retention. Repeated new keys still create new events; this is not a limiter.

## Local verification

```sh
npm run test:payments:reconciliation:sql
npm run test:payments:uncertainty:sql
npx -y deno@latest test --no-lock --allow-env supabase/functions
npm run build
npm run lint
git diff --check
```

The new runner requires initdb/pg_ctl/psql, creates a disposable cluster on its own
Unix socket with TCP disabled, loads actual relevant migrations, stubs only Vault/Auth
infrastructure, executes SQL assertions and genuine concurrent sessions, then removes
the cluster. It never reads Supabase credentials or connects to the remote project.
Tests explicitly report skipped if PostgreSQL binaries are unavailable; skipping is
not confirmation of SQL validity. Never run the fixture SQL in an application DB.
