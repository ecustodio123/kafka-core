import type { ExpectedCulqiTestCharge } from "./culqi-test-evidence.ts";

// Synthetic contract fixtures, never recordings from a merchant or cardholder.
// Financial field names follow official examples; values/identifiers are fictitious.
export const expectedCharge: ExpectedCulqiTestCharge = {
  storeId: 1,
  orderId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  paymentAttemptId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  amountCents: 1000,
  environment: "test",
  currency: "PEN",
  chargeId: "chr_test_1234567890abcdef",
};

export function chargeFixture(patch: Record<string, unknown> = {}) {
  return {
    object: "charge",
    id: expectedCharge.chargeId,
    amount: 1000,
    currency_code: "PEN",
    capture: true,
    capture_date: 1669244278000,
    paid: false,
    dispute: false,
    amount_refunded: 0,
    current_amount: 1000,
    operations: [],
    metadata: {
      kafka_store_id: "1",
      kafka_order_id: expectedCharge.orderId,
      kafka_payment_attempt_id: expectedCharge.paymentAttemptId,
    },
    ...patch,
  };
}

// Both shapes appear in provider examples. Neither is interpreted as final state.
export function threeDsFixture() {
  return { action_code: "REVIEW", requires_3ds: true };
}

export function refundedFixture() {
  return chargeFixture({
    amount_refunded: 200,
    current_amount: 800,
    operations: [{ type: "devolucion", operation_id: "ref_test_synthetic" }],
  });
}
