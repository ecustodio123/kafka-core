import {
  assertEquals,
  assertMatch,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createHandler } from "./index.ts";

const ORIGIN = "http://localhost:5173";
const STORE_ID = 1;
const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const TOKEN = "safe-payment-session-token";

Deno.test("get-order-payment-status returns minimal authorized status", async () => {
  const fake = createFakeSupabase();
  const handler = createTestHandler(fake);
  const response = await post(handler);
  const body = await response.json();

  assertEquals(response.status, 200);
  assertEquals(body.valid, true);
  assertEquals(body.store_id, STORE_ID);
  assertEquals(body.order_id, ORDER_ID);
  assertEquals(body.order_status, "pending_payment");
  assertEquals(body.payment_attempt.status, "processing");
  assertEquals(body.payment_attempt.requires_3ds, true);
  assertEquals(body.payment_attempt.three_ds_status, "required");
  assertNoSensitiveValues(body);
  assertEquals(
    fake.calls[0].name,
    "get_order_payment_status_for_session",
  );
  assertEquals(
    fake.calls[0].args.p_token_hash,
    await sha256Hex(TOKEN),
  );
});

Deno.test("get-order-payment-status rejects invalid token", async () => {
  const fake = createFakeSupabase({ valid: false, reason: "invalid" });
  const handler = createTestHandler(fake);
  const response = await post(handler, {
    payment_session_token: "wrong-payment-session-token",
  });
  const body = await response.json();

  assertEquals(response.status, 401);
  assertMatch(body.error, /sesion/i);
});

Deno.test("get-order-payment-status rejects expired token", async () => {
  const fake = createFakeSupabase({ valid: false, reason: "expired" });
  const handler = createTestHandler(fake);
  const response = await post(handler);
  const body = await response.json();

  assertEquals(response.status, 401);
  assertMatch(body.error, /sesion/i);
});

Deno.test("get-order-payment-status rejects session from another store", async () => {
  const fake = createFakeSupabase({ valid: false, reason: "invalid" });
  const handler = createTestHandler(fake);
  const response = await post(handler, { store_id: 2 });

  assertEquals(response.status, 401);
});

Deno.test("get-order-payment-status returns paid order state", async () => {
  const fake = createFakeSupabase({
    order_status: "paid",
    paid_at: "2026-10-14T10:00:00.000Z",
    payment_attempt: {
      id: "22222222-2222-4222-8222-222222222222",
      status: "paid",
      requires_3ds: false,
      three_ds_status: null,
      requires_reconciliation: false,
      failure_code: null,
      updated_at: "2026-10-14T10:00:00.000Z",
    },
  });
  const handler = createTestHandler(fake);
  const response = await post(handler);
  const body = await response.json();

  assertEquals(response.status, 200);
  assertEquals(body.order_status, "paid");
  assertEquals(body.payment_attempt.status, "paid");
  assertEquals(body.payment_attempt.requires_reconciliation, false);
});

Deno.test("get-order-payment-status exposes processing and uncertain states minimally", async () => {
  const processingFake = createFakeSupabase({
    payment_attempt: {
      id: "22222222-2222-4222-8222-222222222222",
      status: "processing",
      requires_3ds: false,
      three_ds_status: null,
      requires_reconciliation: true,
      failure_code: null,
      updated_at: "2026-10-14T10:00:00.000Z",
    },
  });
  const uncertainFake = createFakeSupabase({
    payment_attempt: {
      id: "22222222-2222-4222-8222-222222222222",
      status: "processing",
      requires_3ds: true,
      three_ds_status: "completion_processing",
      requires_reconciliation: true,
      failure_code: null,
      updated_at: "2026-10-14T10:00:00.000Z",
    },
  });

  const processingBody = await (await post(createTestHandler(processingFake)))
    .json();
  const uncertainBody = await (await post(createTestHandler(uncertainFake)))
    .json();

  assertEquals(processingBody.payment_attempt.status, "processing");
  assertEquals(
    processingBody.payment_attempt.requires_reconciliation,
    true,
  );
  assertEquals(
    uncertainBody.payment_attempt.three_ds_status,
    "completion_processing",
  );
  assertEquals(
    uncertainBody.payment_attempt.requires_reconciliation,
    true,
  );
});

Deno.test("get-order-payment-status duplicate polls return the same safe state", async () => {
  const fake = createFakeSupabase();
  const handler = createTestHandler(fake);
  const [firstResponse, secondResponse] = await Promise.all([
    post(handler),
    post(handler),
  ]);
  const firstBody = await firstResponse.json();
  const secondBody = await secondResponse.json();

  assertEquals(firstResponse.status, 200);
  assertEquals(secondResponse.status, 200);
  assertEquals(firstBody.payment_attempt.id, secondBody.payment_attempt.id);
  assertEquals(fake.calls.length, 2);
  assertNoSensitiveValues(secondBody);
});

function createTestHandler(fake: ReturnType<typeof createFakeSupabase>) {
  return createHandler({
    createSupabaseClient: () => fake,
    env: (name) =>
      name === "GET_ORDER_PAYMENT_STATUS_ALLOWED_ORIGINS" ? ORIGIN : undefined,
  });
}

async function post(
  handler: (request: Request) => Promise<Response>,
  payloadOverrides: Record<string, unknown> = {},
) {
  return await handler(
    new Request("http://localhost/functions/v1/get-order-payment-status", {
      body: JSON.stringify({
        store_id: STORE_ID,
        order_id: ORDER_ID,
        payment_session_token: TOKEN,
        ...payloadOverrides,
      }),
      headers: {
        "Content-Type": "application/json",
        Origin: ORIGIN,
      },
      method: "POST",
    }),
  );
}

function createFakeSupabase(overrides: Record<string, unknown> = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const response = {
    valid: true,
    store_id: STORE_ID,
    order_id: ORDER_ID,
    order_status: "pending_payment",
    currency: "PEN",
    total_amount_cents: 1299,
    paid_at: null,
    payment_attempt: {
      id: "22222222-2222-4222-8222-222222222222",
      status: "processing",
      requires_3ds: true,
      three_ds_status: "required",
      requires_reconciliation: false,
      failure_code: null,
      updated_at: "2026-10-14T10:00:00.000Z",
    },
    ...overrides,
  };

  return {
    calls,
    async rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });

      if (name !== "get_order_payment_status_for_session") {
        return { data: null, error: { message: `RPC inesperado: ${name}` } };
      }

      return { data: response, error: null };
    },
  };
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );

  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function assertNoSensitiveValues(value: unknown) {
  const serialized = JSON.stringify(value);

  assertEquals(/sk_test_/.test(serialized), false);
  assertEquals(/pk_test_/.test(serialized), false);
  assertEquals(/tkn_test_/.test(serialized), false);
  assertEquals(/payment-session-token/.test(serialized), false);
  assertEquals(/[a-f0-9]{64}/.test(serialized), false);
  assertEquals(/buyer@example.com/.test(serialized), false);
}
