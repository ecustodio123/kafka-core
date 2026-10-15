# Culqi TEST financial evidence contract (not integrated)

Reviewed 2026-10-15. Pure assessment only: no HTTP, database, Vault, environment,
logging or state changes. No migration 014. Current callers and diagnostic output
are unchanged. This module is NOT authorization to finalize a payment.

## Contract

`validateCulqiTestEvidence({ operation, httpStatus, body, expected })` accepts:

- `operation`: `retrieve_charge`, `create_charge`, `complete_3ds`.
- `httpStatus`: integer HTTP status, or null for unavailable transport evidence.
- `body`: unknown parsed provider data, not the public diagnostic response.
- `expected`: server-derived `storeId`, `orderId`, `paymentAttemptId`, positive
  integer `amountCents` within PostgreSQL int range, `currency: PEN`, `environment: test`.
  `chargeId` is required for retrieval. For first POST it may be unknown; all Kafka
  metadata must still match to establish compatible identity. Never trust these
  expectations or a provider response supplied by the checkout browser.

Return values:

- `identity.status`: `compatible`, `insufficient`, `contradictory`, with fixed field
  names in `missing`/`mismatches`. Compatibility means a matching charge object,
  TEST ID, integer amount, PEN and all three exact Kafka metadata references.
- `capture.status`: always `unverified`, with allowlisted observations and blockers.
  Identity contradictions and financial risk/shape blockers are distinct. A refund,
  dispute or 3DS challenge does not imply the original charge was declined.
- `canFinalizePaid`: always literal `false`. No sufficiently-verified capture branch
  is implemented in this version. Even an identity-compatible, plausible capture
  object cannot be used to authorize a terminal financial transition.

`CULQI_TEST_CAPTURE_POLICY` is a frozen constant disabled pending provider confirmation,
not an environment toggle or caller option. There is no switch to enable it. A later
review must explicitly implement/test the verified branch before any production use.
No raw provider strings, IDs, metadata, card/source data or 3DS secrets are reflected.
The module does not infer financial failure or return authenticated-3DS assertions.

## Evidence classification

Documented:

- [Retrieve charge / charge object](https://apidocs.culqi.com/#tag/Cargos/operation/consultar-cargo)
  documents GET by ID, private-key access, amount/currency, `capture`, `dispute`,
  metadata, refunded/current amounts and operations. Retrieval success is not a
  financial conclusion. The metadata is editable merchant linkage, not a bank signature.
- [Capture guide](https://docs.culqi.com/es/documentacion/pagos-online/cargo-unico/captura/)
  separates authorization (funds held) and capture. Sending `capture: true` requests
  immediate capture; the outbound request itself is not proof of its success.
- [Refunds](https://docs.culqi.com/es/documentacion/pagos-online/operaciones/devoluciones/)
  can be partial or full. A refund is a separate financial operation after a purchase.
- [Culqi 3DS v1](https://docs.culqi.com/es/documentacion/culqi-3ds/v1/uso-libreria/)
  describes reusing source/device and sending authentication data. These fields or
  browser-generated flags are not independent verification of authentication/capture.

Ambiguous or unconfirmed for financial automation:

- API descriptions say `capture` describes a captured charge, but the full minimal
  field combination guaranteeing final capture (including outcome/operations) is
  not confirmed for this integration. Therefore `capture: true` remains an observation.
- The API describes `paid` inconsistently as dispute-related, and examples show
  `capture: true` together with `paid: false`. No paid/capture equivalence is assumed.
- `capture_date` is documented/examples shown as Unix timestamps with differing
  scales across sections. This module only observes a positive safe integer; no
  seconds/milliseconds conversion, freshness or settlement inference is made.
- [3DS flow](https://docs.culqi.com/es/documentacion/culqi-3ds/flujo-con-3ds/)
  and the v1 library page reverse POST 200/201 meanings. Both statuses alone are
  insufficient; no generic HTTP-success-to-payment-success rule is implemented.
- Operations appear as arrays and objects in examples. Nonempty operations need
  separate review; empty/missing data does not independently prove absence of refund.
  No arithmetic identity for `current_amount` is assumed without confirmation.
- No independently verifiable authentication proof, webhook authenticity mechanism,
  merchant-account identity or immutable charge-state version is established here.

Confirm these points with Culqi support and version-specific documentation plus
sanitized TEST examples already available to the merchant; no new charge is needed
for this subphase. Synthetic fixtures test conservatism, NOT actual provider behavior.

## Current callers and exact future integration points

No handler imports this module yet. This is deliberate: changing the decisions now
would alter the current charge flow, which is outside this subphase.

1. `create-payment-attempt/index.ts`: `createCulqiCharge`, HTTP 200 branch
   (currently line 1050), treats a TEST ID as success. Its caller invokes
   `finalize_kafka_payment_attempt(... paid ...)` around line 593. Future integration
   must assess the ORIGINAL response against the persisted order/attempt context
   BEFORE producing `kind: success`; unverified results must persist uncertainty
   without another POST. Existing sanitized payloads lack enough fields to assess.
2. `complete-payment-3ds/index.ts`: `createCulqi3dsCharge`, HTTP 200 branch
   (currently line 854), uses the same ID-only success rule, finalized around line 437.
   Apply the same gate before emitting success, preserve the acquired claim on
   uncertainty, never repeat the charge, and never turn 3DS data into verified proof.
3. `reconcile-payment-attempt/index.ts`: after bounded GET parsing, the local
   identity checks begin around line 269 and `found_compatible` is returned around
   line 312. A future reviewed replacement may reuse identity results but must
   preserve the existing diagnostic-only response contract and read-only behavior.
   Do not pass that stripped public response to this validator as provider evidence.

Future enablement must align BOTH paid callers with one reviewed verified-capture
policy. Until then keep all payment/diagnostic flags disabled; an unused module
does not repair their existing success criteria or protect direct service-role RPC use.
Keep MOCK private and distinct from financial evidence; synthetic payment success is
not provider evidence. No change to `finalize_kafka_payment_attempt` is made here.

## Next step toward 014

First freeze a provider-confirmed evidence matrix and add the verified branch/tests.
Then integrate both callers and persist uncertain outcomes safely. Only afterward
prepare the service-role-only apply RPC with orders -> attempts locks, snapshot
revalidation, idempotent evidence/audit events and unchanged 3DS guarantees.
The pure module cannot authenticate HTTP provenance, resolve rotated-account identity,
prevent stale observations, enforce rate limits or stop an already in-flight POST.

## Local tests

```sh
npm run test:payments:evidence:unit
npx -y deno@latest check --no-lock supabase/functions/_shared/culqi-test-evidence.ts
npx -y deno@latest test --no-lock --allow-env supabase/functions
npm run build
npm run lint
git diff --check
```

Fixtures are hand-written synthetic subsets, containing no card data, sources,
credentials, customer details or real merchant records. Unit tests run without
runtime network or environment permissions; no remote project or provider is called.
