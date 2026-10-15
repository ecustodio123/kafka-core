export type ExpectedCulqiTestCharge = {
  storeId: number;
  orderId: string;
  paymentAttemptId: string;
  amountCents: number;
  currency: "PEN";
  environment: "test";
  // Required for GET; optional for the first POST response (not known yet).
  chargeId?: string;
};

export type CulqiTestEvidenceInput = {
  operation: "retrieve_charge" | "create_charge" | "complete_3ds";
  httpStatus: number | null;
  body: unknown;
  expected: ExpectedCulqiTestCharge;
};

export const CULQI_TEST_CAPTURE_POLICY = Object.freeze(
  {
    id: "disabled_pending_provider_confirmation",
    enabled: false,
  } as const,
);

type IdentityField =
  | "expected_context"
  | "object"
  | "charge_id"
  | "amount"
  | "currency"
  | "metadata"
  | "metadata_store"
  | "metadata_order"
  | "metadata_attempt";

export type CulqiTestEvidence = {
  identity: {
    status: "compatible" | "insufficient" | "contradictory";
    missing: IdentityField[];
    mismatches: IdentityField[];
  };
  capture: {
    // There is deliberately no reachable 'verified' result in this contract version.
    status: "unverified";
    policy: typeof CULQI_TEST_CAPTURE_POLICY.id;
    blockers: string[];
    observations: {
      captureReported: boolean | null;
      paidReported: boolean | null;
      positiveCaptureDateReported: boolean;
      refundReported: boolean | null;
      disputeReported: boolean | null;
      operationsReported: boolean | null;
      threeDsSignalReported: boolean;
    };
  };
  canFinalizePaid: false;
};

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CHARGE = /^chr_test_[A-Za-z0-9]{1,151}$/;

/** Pure shape/consistency assessment, NOT authentication of a provider response. */
export function validateCulqiTestEvidence(
  input: CulqiTestEvidenceInput,
): CulqiTestEvidence {
  const missing: IdentityField[] = [];
  const mismatches: IdentityField[] = [];
  const blockers: string[] = ["capture_policy_disabled"];
  const expected = input.expected;
  const body = isObject(input.body) ? input.body : {};
  const expectedValid = isObject(expected) &&
    Number.isSafeInteger(expected.storeId) && expected.storeId > 0 &&
    exactPattern(expected.orderId, UUID) &&
    exactPattern(expected.paymentAttemptId, UUID) &&
    cents(expected.amountCents) && expected.amountCents > 0 &&
    expected.currency === "PEN" && expected.environment === "test" &&
    (expected.chargeId === undefined ||
      exactPattern(expected.chargeId, CHARGE)) &&
    (input.operation !== "retrieve_charge" ||
      expected.chargeId !== undefined) &&
    ["retrieve_charge", "create_charge", "complete_3ds"].includes(
      input.operation,
    );
  if (!expectedValid) mismatches.push("expected_context");

  const check = (value: unknown, target: unknown, field: IdentityField) => {
    if (value === undefined || value === null) missing.push(field);
    else if (value !== target) mismatches.push(field);
  };
  if (expectedValid) {
    check(body.object, "charge", "object");
    if (body.id === undefined || body.id === null) missing.push("charge_id");
    else if (
      !exactPattern(body.id, CHARGE) ||
      (expected.chargeId !== undefined && body.id !== expected.chargeId)
    ) {
      mismatches.push("charge_id");
    }
    check(body.amount, expected.amountCents, "amount");
    check(body.currency_code, "PEN", "currency");
    if (body.metadata != null && !isObject(body.metadata)) {
      mismatches.push("metadata");
    }
    const metadata = isObject(body.metadata) ? body.metadata : {};
    check(metadata.kafka_store_id, String(expected.storeId), "metadata_store");
    check(metadata.kafka_order_id, expected.orderId, "metadata_order");
    check(
      metadata.kafka_payment_attempt_id,
      expected.paymentAttemptId,
      "metadata_attempt",
    );
  }

  const identityStatus = mismatches.length
    ? "contradictory"
    : missing.length
    ? "insufficient"
    : "compatible";
  if (identityStatus !== "compatible") blockers.push("identity_not_compatible");
  // HTTP status is transport evidence only; POST 200/201 meanings conflict in official docs.
  if (
    input.operation === "retrieve_charge"
      ? input.httpStatus !== 200
      : input.httpStatus !== 200 && input.httpStatus !== 201
  ) {
    blockers.push("transport_not_successful_or_unknown");
  }
  if (input.operation !== "retrieve_charge") {
    blockers.push("post_success_semantics_unconfirmed");
  }

  const captureReported = bool(body.capture);
  const paidReported = bool(body.paid);
  const disputeReported = bool(body.dispute);
  const positiveCaptureDateReported = typeof body.capture_date === "number" &&
    Number.isSafeInteger(body.capture_date) && body.capture_date > 0;
  if (captureReported !== true) {
    blockers.push("capture_not_explicitly_reported");
  }
  if (!positiveCaptureDateReported) {
    blockers.push("capture_date_absent_or_invalid");
  } else blockers.push("capture_date_semantics_unconfirmed");
  // No epoch/unit conversion or comparison with paid: those semantics need confirmation.
  if (body.paid != null && paidReported === null) {
    blockers.push("paid_field_invalid");
  }

  const refundReported = cents(body.amount_refunded)
    ? body.amount_refunded > 0
    : null;
  if (refundReported === null) {
    blockers.push("refund_evidence_missing_or_invalid");
  }
  if (refundReported === true) blockers.push("refund_requires_separate_review");
  if (
    cents(body.amount_refunded) && cents(body.amount) &&
    body.amount_refunded > body.amount
  ) {
    blockers.push("refund_amount_exceeds_original");
  }
  if (!cents(body.current_amount)) {
    blockers.push("current_amount_missing_or_invalid");
  } else if (cents(body.amount) && body.current_amount > body.amount) {
    blockers.push("current_amount_exceeds_original");
  }
  // Do not assume current_amount = amount - refunds without a confirmed provider contract.
  if (disputeReported !== false) {
    blockers.push(
      disputeReported
        ? "dispute_requires_separate_review"
        : "dispute_evidence_missing_or_invalid",
    );
  }
  const operationsReported = Array.isArray(body.operations)
    ? body.operations.length > 0
    : isObject(body.operations)
    ? Object.keys(body.operations).length > 0
    : null;
  if (operationsReported === null) {
    blockers.push("operations_missing_or_invalid");
  }
  if (operationsReported === true) {
    blockers.push("operations_require_separate_review");
  }

  const threeDsSignalReported = input.operation === "complete_3ds" ||
    body.requires_3ds === true || body.action_code === "REVIEW" ||
    body.authentication_3DS != null;
  if (threeDsSignalReported) {
    blockers.push("three_ds_not_independently_verified");
  }

  return {
    identity: { status: identityStatus, missing, mismatches },
    capture: {
      status: "unverified",
      policy: CULQI_TEST_CAPTURE_POLICY.id,
      blockers,
      observations: {
        captureReported,
        paidReported,
        positiveCaptureDateReported,
        refundReported,
        disputeReported,
        operationsReported,
        threeDsSignalReported,
      },
    },
    canFinalizePaid: false,
  };
}

function exactPattern(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && value.trim() === value &&
    pattern.test(value);
}
function cents(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) &&
    value >= 0 && value <= 2147483647;
}
function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
