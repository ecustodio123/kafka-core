import {
  assertArrayIncludes as assertIncludes,
  assertEquals,
  assertFalse,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  CULQI_TEST_CAPTURE_POLICY,
  validateCulqiTestEvidence,
} from "./culqi-test-evidence.ts";
import {
  chargeFixture,
  expectedCharge,
  refundedFixture,
  threeDsFixture,
} from "./culqi-test-evidence.fixtures.ts";

function assess(body: unknown = chargeFixture()) {
  return validateCulqiTestEvidence({
    body,
    expected: expectedCharge,
    operation: "retrieve_charge",
    httpStatus: 200,
  });
}

Deno.test("matching identity is compatible, but capture confirmation is disabled even for a complete charge", () => {
  const result = assess();
  assertEquals(result.identity, {
    status: "compatible",
    missing: [],
    mismatches: [],
  });
  assertEquals(result.capture.status, "unverified");
  assertEquals(result.capture.observations.captureReported, true);
  assertEquals(result.canFinalizePaid, false);
  assertEquals(CULQI_TEST_CAPTURE_POLICY.enabled, false);
  assertEquals(Object.isFrozen(CULQI_TEST_CAPTURE_POLICY), true);
  assertIncludes(result.capture.blockers, [
    "capture_policy_disabled",
    "capture_date_semantics_unconfirmed",
  ]);
});

Deno.test("missing and malformed response objects cannot establish identity", () => {
  for (
    const body of [null, [], "charge", 200, {}, { id: expectedCharge.chargeId }]
  ) {
    const result = assess(body);
    assertEquals(result.identity.status, "insufficient");
    assertFalse(result.canFinalizePaid);
  }
});

Deno.test("amounts are strict persisted integer cents, never coerced from provider strings", () => {
  for (
    const amount of [
      999,
      "1000",
      0,
      -1,
      1000.1,
      Number.MAX_SAFE_INTEGER + 1,
      true,
    ]
  ) {
    const result = assess(chargeFixture({ amount }));
    assertEquals(result.identity.status, "contradictory");
    assertIncludes(result.identity.mismatches, ["amount"]);
    assertFalse(result.canFinalizePaid);
  }
});

Deno.test("charge object, TEST environment, expected charge ID and PEN must match", () => {
  for (
    const patch of [
      { object: "token" },
      { id: "chr_live_1234567890abcdef" },
      { id: "chr_test_another" },
      { id: expectedCharge.chargeId + "\n" },
      { currency_code: "USD" },
    ]
  ) {
    assertEquals(assess(chargeFixture(patch)).identity.status, "contradictory");
  }
});

Deno.test("store, order and attempt metadata are mandatory, strictly typed and tenant-specific", () => {
  for (
    const key of [
      "kafka_store_id",
      "kafka_order_id",
      "kafka_payment_attempt_id",
    ]
  ) {
    const body = chargeFixture();
    body.metadata[key as keyof typeof body.metadata] =
      "different-tenant-or-order";
    assertEquals(assess(body).identity.status, "contradictory");
  }
  assertEquals(
    assess(chargeFixture({ metadata: {} })).identity.status,
    "insufficient",
  );
  assertEquals(
    assess(chargeFixture({ metadata: [] })).identity.status,
    "contradictory",
  );
  const body = chargeFixture();
  assertEquals(
    assess(chargeFixture({ metadata: { ...body.metadata, kafka_store_id: 1 } }))
      .identity.status,
    "contradictory",
  );
});

Deno.test("invalid backend context fails closed, including missing retrieval reference", () => {
  for (
    const patch of [
      { storeId: 0 },
      { storeId: Number.MAX_SAFE_INTEGER + 1 },
      { amountCents: -1 },
      { currency: "USD" },
      { environment: "live" },
      { orderId: "invalid" },
      { paymentAttemptId: "invalid" },
      { chargeId: undefined },
      { chargeId: "https://evil.test" },
    ]
  ) {
    const expected = { ...expectedCharge, ...patch } as typeof expectedCharge;
    const result = validateCulqiTestEvidence({
      body: chargeFixture(),
      expected,
      operation: "retrieve_charge",
      httpStatus: 200,
    });
    assertIncludes(result.identity.mismatches, ["expected_context"]);
    assertFalse(result.canFinalizePaid);
  }
});

Deno.test("first POST may bind new charge identity through metadata, never authorize paid", () => {
  const result = validateCulqiTestEvidence({
    body: chargeFixture(),
    expected: { ...expectedCharge, chargeId: undefined },
    operation: "create_charge",
    httpStatus: 200,
  });
  assertEquals(result.identity.status, "compatible");
  assertFalse(result.canFinalizePaid);
  assertIncludes(result.capture.blockers, [
    "post_success_semantics_unconfirmed",
  ]);
});

Deno.test("200/201/404 and provider errors never imply financial success or failure", () => {
  for (
    const operation of [
      "retrieve_charge",
      "create_charge",
      "complete_3ds",
    ] as const
  ) {
    for (const httpStatus of [null, 200, 201, 400, 402, 404, 429, 500]) {
      const result = validateCulqiTestEvidence({
        body: chargeFixture(),
        expected: expectedCharge,
        operation,
        httpStatus,
      });
      assertFalse(result.canFinalizePaid);
      assertEquals(result.capture.status, "unverified");
      if (httpStatus === 404) {
        assertIncludes(result.capture.blockers, [
          "transport_not_successful_or_unknown",
        ]);
      }
    }
  }
});

Deno.test("capture and paid flags, including combinations, never suffice", () => {
  for (const capture of [true, false, undefined, "true"]) {
    for (const paid of [true, false, undefined, "true"]) {
      const result = assess(chargeFixture({ capture, paid }));
      assertFalse(result.canFinalizePaid);
      assertEquals(result.identity.status, "compatible");
    }
  }
});

Deno.test("missing, malformed and conflicting capture signals remain unverified", () => {
  for (
    const capture_date of [
      undefined,
      null,
      0,
      -1,
      "1669244278000",
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
    ]
  ) {
    const result = assess(chargeFixture({ capture_date }));
    assertIncludes(result.capture.blockers, ["capture_date_absent_or_invalid"]);
    assertFalse(result.canFinalizePaid);
  }
  const result = assess(chargeFixture({ capture: false }));
  assertIncludes(result.capture.blockers, ["capture_not_explicitly_reported"]);
  assertFalse(result.canFinalizePaid);
});

Deno.test("3DS required and completion data do not establish authentication or capture", () => {
  const challenge = assess(threeDsFixture());
  assertEquals(challenge.identity.status, "insufficient");
  assertIncludes(challenge.capture.blockers, [
    "three_ds_not_independently_verified",
  ]);
  const completed = validateCulqiTestEvidence({
    body: chargeFixture(),
    expected: expectedCharge,
    operation: "complete_3ds",
    httpStatus: 200,
  });
  assertEquals(completed.identity.status, "compatible");
  assertIncludes(completed.capture.blockers, [
    "three_ds_not_independently_verified",
  ]);
  assertFalse(completed.canFinalizePaid);
});

Deno.test("partial/full refunds and operations require separate financial review", () => {
  const partial = assess(refundedFixture());
  assertEquals(partial.identity.status, "compatible");
  assertIncludes(partial.capture.blockers, [
    "refund_requires_separate_review",
    "operations_require_separate_review",
  ]);
  for (const amount_refunded of [1000, 1001]) {
    const result = assess(
      chargeFixture({ amount_refunded, current_amount: 0 }),
    );
    assertFalse(result.canFinalizePaid);
    if (amount_refunded > 1000) {
      assertIncludes(result.capture.blockers, [
        "refund_amount_exceeds_original",
      ]);
    }
  }
  for (
    const operations of [
      undefined,
      null,
      [],
      {},
      { type: "devolucion" },
      "unknown",
    ]
  ) {
    assertFalse(assess(chargeFixture({ operations })).canFinalizePaid);
  }
});

Deno.test("disputes and missing risk evidence cannot be interpreted as a declined payment", () => {
  for (const dispute of [true, undefined, null, "false"]) {
    const result = assess(chargeFixture({ dispute }));
    assertEquals(result.identity.status, "compatible");
    assertFalse(result.canFinalizePaid);
    assertIncludes(result.capture.blockers, [
      dispute === true
        ? "dispute_requires_separate_review"
        : "dispute_evidence_missing_or_invalid",
    ]);
  }
});

Deno.test("validator returns only allowlisted diagnostics, never input values, sources or auth data", () => {
  const marker = "sensitive-synthetic-marker";
  const body = chargeFixture({
    source: { id: marker },
    email: marker,
    authentication_3DS: { cavv: marker },
    metadata: { kafka_store_id: marker },
    outcome: { merchant_message: marker },
    capture_policy_enabled: true,
    canFinalizePaid: true,
    three_ds_authenticated: true,
  });
  const output = JSON.stringify(assess(body));
  assertFalse(output.includes(marker));
  assertFalse(assess(body).canFinalizePaid);
});

Deno.test("assessment is deterministic, side-effect-free and does not mutate fixtures", () => {
  const body = chargeFixture();
  const before = JSON.stringify(body);
  assertEquals(assess(body), assess(body));
  assertEquals(JSON.stringify(body), before);
});
