import {
  assertEquals,
  assertMatch,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createHandler } from "./index.ts";

const STORE_ID = 1;
const ORIGIN = "http://localhost:5173";
const SECRET = "mock-test-runner-secret-with-at-least-32-chars";
const ORDER_ID = "11111111-1111-4111-8111-111111111111";

Deno.test("MOCK success reserves, processes and finalizes paid", async () => {
  const fake = createFakeSupabase();
  const handler = createTestHandler(fake, {
    CREATE_PAYMENT_ATTEMPT_MOCK_RESULT: "success",
  });
  const response = await post(handler);
  const body = await response.json();

  assertEquals(response.status, 201);
  assertEquals(body.payment_attempt.status, "paid");
  assertEquals(body.payment_attempt.order_status, "paid");
  assertEquals(body.payment_result.result, "success");
  assertEquals(fake.calls.map((call) => call.name), [
    "reserve_kafka_payment_attempt",
    "claim_kafka_payment_attempt_processing",
    "finalize_kafka_payment_attempt",
  ]);
  assertNoSensitiveValues(body);
});

Deno.test("MOCK failed finalizes definitive rejection", async () => {
  const fake = createFakeSupabase();
  const handler = createTestHandler(fake, {
    CREATE_PAYMENT_ATTEMPT_MOCK_RESULT: "failed",
  });
  const response = await post(handler);
  const body = await response.json();

  assertEquals(response.status, 402);
  assertEquals(body.payment_attempt.status, "failed");
  assertEquals(body.payment_attempt.order_status, "payment_failed");
  assertEquals(body.payment_attempt.failure_code, "mock_definitive_rejection");
});

Deno.test("MOCK uncertain keeps processing and does not finalize", async () => {
  const fake = createFakeSupabase();
  const handler = createTestHandler(fake, {
    CREATE_PAYMENT_ATTEMPT_MOCK_RESULT: "uncertain",
  });
  const response = await post(handler);
  const body = await response.json();

  assertEquals(response.status, 202);
  assertEquals(body.payment_attempt.status, "processing");
  assertEquals(body.payment_attempt.order_status, "pending_payment");
  assertEquals(body.payment_result.requires_reconciliation, true);
  assertEquals(fake.calls.map((call) => call.name), [
    "reserve_kafka_payment_attempt",
    "claim_kafka_payment_attempt_processing",
  ]);
});

Deno.test("MOCK idempotency returns existing attempt without reprocessing", async () => {
  const fake = createFakeSupabase();
  const handler = createTestHandler(fake, {
    CREATE_PAYMENT_ATTEMPT_MOCK_RESULT: "success",
  });

  const firstResponse = await post(handler);
  const firstBody = await firstResponse.json();
  const secondResponse = await post(handler);
  const secondBody = await secondResponse.json();

  assertEquals(secondResponse.status, 200);
  assertEquals(secondBody.payment_attempt.id, firstBody.payment_attempt.id);
  assertEquals(secondBody.payment_result.processed, false);
  assertEquals(secondBody.payment_result.reason, "existing_attempt");
  assertEquals(
    fake.calls.filter((call) =>
      call.name === "claim_kafka_payment_attempt_processing"
    )
      .length,
    1,
  );
  assertEquals(
    fake.calls.filter((call) => call.name === "finalize_kafka_payment_attempt")
      .length,
    1,
  );
});

Deno.test("MOCK reused key with different source returns conflict before processing", async () => {
  const fake = createFakeSupabase();
  const handler = createTestHandler(fake, {
    CREATE_PAYMENT_ATTEMPT_MOCK_RESULT: "success",
  });

  await post(handler, { source_id: "tkn_test_originalsource" });
  const response = await post(handler, { source_id: "tkn_test_changedsource" });
  const body = await response.json();

  assertEquals(response.status, 409);
  assertMatch(body.error, /idempotency/i);
  assertEquals(
    fake.calls.filter((call) =>
      call.name === "claim_kafka_payment_attempt_processing"
    )
      .length,
    1,
  );
});

Deno.test("MOCK allows a new attempt after definitive rejection", async () => {
  const fake = createFakeSupabase();
  const env = createEnv({ CREATE_PAYMENT_ATTEMPT_MOCK_RESULT: "failed" });
  const handler = createHandler({
    createSupabaseClient: () => fake,
    env: (name) => env[name],
    fetch: createFakeFetch({ status: 201 }),
  });

  const failedResponse = await post(handler, {
    idempotency_key: "attempt-failed",
  });
  const failedBody = await failedResponse.json();
  assertEquals(failedBody.payment_attempt.status, "failed");

  env.CREATE_PAYMENT_ATTEMPT_MOCK_RESULT = "success";
  const retryResponse = await post(handler, {
    idempotency_key: "attempt-retry",
  });
  const retryBody = await retryResponse.json();

  assertEquals(retryResponse.status, 201);
  assertEquals(retryBody.payment_attempt.status, "paid");
  assertEquals(
    retryBody.payment_attempt.id !== failedBody.payment_attempt.id,
    true,
  );
});

Deno.test("MOCK rejects unmarked orders before modifying attempts", async () => {
  const fake = createFakeSupabase({
    whatsapp_message: "Pedido normal sin marcador de prueba",
  });
  const handler = createTestHandler(fake, {
    CREATE_PAYMENT_ATTEMPT_MOCK_RESULT: "success",
  });
  const response = await post(handler);
  const body = await response.json();

  assertEquals(response.status, 403);
  assertMatch(body.error, /simulacion/i);
  assertEquals(fake.calls.length, 0);
});

Deno.test("MOCK requires private test runner secret", async () => {
  const fake = createFakeSupabase();
  const handler = createTestHandler(fake, {
    CREATE_PAYMENT_ATTEMPT_MOCK_RESULT: "success",
  });
  const response = await post(handler, undefined, {
    "x-kafka-mock-test-secret": "wrong",
  });

  assertEquals(response.status, 401);
  assertEquals(fake.calls.length, 0);
});

Deno.test("CULQI_TEST success validates session, charges once and finalizes paid", async () => {
  const fake = createFakeSupabase({
    customer_email: "buyer@example.com",
    whatsapp_message: "normal commerce order",
  });
  const fetch = createFakeFetch({
    status: 201,
    body: { id: "chr_test_paid123", object: "charge" },
  });
  const handler = createTestHandler(fake, {
    CREATE_PAYMENT_ATTEMPT_MODE: "culqi_test",
    CREATE_PAYMENT_ATTEMPT_MOCK_ENABLED: "false",
  }, fetch);
  const response = await post(handler, {
    payment_session_token: "payment-session-token",
  });
  const body = await response.json();

  assertEquals(response.status, 201);
  assertEquals(body.payment_attempt.status, "paid");
  assertEquals(body.payment_result.mode, "culqi_test");
  assertEquals(body.payment_result.reason, "culqi_charge_paid");
  assertEquals(fetch.calls.length, 1);
  assertEquals(fetch.calls[0].input, "https://api.culqi.com/v2/charges");
  const headers = fetch.calls[0].init?.headers as Record<string, string>;
  assertEquals(
    headers.Authorization,
    "Bearer sk_test_privatekeysafe",
  );
  assertEquals(fake.calls.map((call) => call.name), [
    "validate_order_payment_session_and_reserve_attempt",
    "get_culqi_test_private_key_for_payment",
    "claim_kafka_payment_attempt_processing",
    "finalize_kafka_payment_attempt",
  ]);
  assertNoSensitiveValues(body);
});

Deno.test("CULQI_TEST definitive rejection finalizes failed", async () => {
  const fake = createFakeSupabase({
    customer_email: "buyer@example.com",
    whatsapp_message: "normal commerce order",
  });
  const fetch = createFakeFetch({
    body: {
      code: "card_declined",
      decline_code: "insufficient_funds",
      merchant_message: "Card declined",
      type: "card_error",
    },
    status: 402,
  });
  const handler = createTestHandler(fake, {
    CREATE_PAYMENT_ATTEMPT_MODE: "culqi_test",
    CREATE_PAYMENT_ATTEMPT_MOCK_ENABLED: "false",
  }, fetch);
  const response = await post(handler, {
    payment_session_token: "payment-session-token",
  });
  const body = await response.json();

  assertEquals(response.status, 402);
  assertEquals(body.payment_attempt.status, "failed");
  assertEquals(body.payment_attempt.failure_code, "insufficient_funds");
  assertNoSensitiveValues(body);
});

Deno.test("CULQI_TEST ambiguous Culqi error keeps processing", async () => {
  const fake = createFakeSupabase({
    customer_email: "buyer@example.com",
    whatsapp_message: "normal commerce order",
  });
  const fetch = createFakeFetch({
    body: {
      code: "parameter_invalid",
      message: "Invalid request",
      type: "invalid_request_error",
    },
    status: 400,
  });
  const handler = createTestHandler(fake, {
    CREATE_PAYMENT_ATTEMPT_MODE: "culqi_test",
    CREATE_PAYMENT_ATTEMPT_MOCK_ENABLED: "false",
  }, fetch);
  const response = await post(handler, {
    payment_session_token: "payment-session-token",
  });
  const body = await response.json();

  assertEquals(response.status, 202);
  assertEquals(body.payment_attempt.status, "processing");
  assertEquals(body.payment_result.reason, "culqi_ambiguous_400");
  assertEquals(
    fake.calls.filter((call) => call.name === "finalize_kafka_payment_attempt")
      .length,
    0,
  );
});

Deno.test("CULQI_TEST invalid private key fails before claim and HTTP call", async () => {
  const fake = createFakeSupabase(
    {
      customer_email: "buyer@example.com",
      whatsapp_message: "normal commerce order",
    },
    { privateKey: "invalid-key" },
  );
  const fetch = createFakeFetch({ status: 201 });
  const handler = createTestHandler(fake, {
    CREATE_PAYMENT_ATTEMPT_MODE: "culqi_test",
    CREATE_PAYMENT_ATTEMPT_MOCK_ENABLED: "false",
  }, fetch);
  const response = await post(handler, {
    payment_session_token: "payment-session-token",
  });
  const body = await response.json();

  assertEquals(response.status, 500);
  assertMatch(body.error, /configuracion/i);
  assertEquals(fetch.calls.length, 0);
  assertEquals(
    fake.calls.filter((call) =>
      call.name === "claim_kafka_payment_attempt_processing"
    ).length,
    0,
  );
});

Deno.test("CULQI_TEST rejects non official Culqi endpoint before reserve", async () => {
  const fake = createFakeSupabase({
    customer_email: "buyer@example.com",
    whatsapp_message: "normal commerce order",
  });
  const fetch = createFakeFetch({ status: 201 });
  const handler = createTestHandler(fake, {
    CREATE_PAYMENT_ATTEMPT_CULQI_CHARGES_URL: "https://example.test/v2/charges",
    CREATE_PAYMENT_ATTEMPT_MODE: "culqi_test",
    CREATE_PAYMENT_ATTEMPT_MOCK_ENABLED: "false",
  }, fetch);
  const response = await post(handler, {
    payment_session_token: "payment-session-token",
  });
  const body = await response.json();

  assertEquals(response.status, 400);
  assertMatch(body.error, /CULQI_CHARGES_URL/i);
  assertEquals(fetch.calls.length, 0);
  assertEquals(fake.calls.length, 0);
});

Deno.test("CULQI_TEST timeout keeps processing for reconciliation", async () => {
  const fake = createFakeSupabase({
    customer_email: "buyer@example.com",
    whatsapp_message: "normal commerce order",
  });
  const fetch = createFakeFetch({ rejectsWithAbort: true });
  const handler = createTestHandler(fake, {
    CREATE_PAYMENT_ATTEMPT_MODE: "culqi_test",
    CREATE_PAYMENT_ATTEMPT_MOCK_ENABLED: "false",
  }, fetch);
  const response = await post(handler, {
    payment_session_token: "payment-session-token",
  });
  const body = await response.json();

  assertEquals(response.status, 202);
  assertEquals(body.payment_attempt.status, "processing");
  assertEquals(body.payment_result.reason, "culqi_timeout");
  assertEquals(
    fake.calls.filter((call) => call.name === "finalize_kafka_payment_attempt")
      .length,
    0,
  );
});

Deno.test("CULQI_TEST 3DS response keeps processing without finalizing paid", async () => {
  const fake = createFakeSupabase({
    customer_email: "buyer@example.com",
    whatsapp_message: "normal commerce order",
  });
  const fetch = createFakeFetch({ status: 200, body: { object: "charge" } });
  const handler = createTestHandler(fake, {
    CREATE_PAYMENT_ATTEMPT_MODE: "culqi_test",
    CREATE_PAYMENT_ATTEMPT_MOCK_ENABLED: "false",
  }, fetch);
  const response = await post(handler, {
    payment_session_token: "payment-session-token",
  });
  const body = await response.json();

  assertEquals(response.status, 202);
  assertEquals(body.payment_attempt.status, "processing");
  assertEquals(body.payment_result.reason, "culqi_requires_action");
  assertEquals(
    fake.calls.filter((call) => call.name === "finalize_kafka_payment_attempt")
      .length,
    0,
  );
});

Deno.test("CULQI_TEST only acquired claim can call Culqi", async () => {
  const fake = createFakeSupabase(
    {
      customer_email: "buyer@example.com",
      whatsapp_message: "normal commerce order",
    },
    { claimAcquired: false },
  );
  const fetch = createFakeFetch({ status: 201 });
  const handler = createTestHandler(fake, {
    CREATE_PAYMENT_ATTEMPT_MODE: "culqi_test",
    CREATE_PAYMENT_ATTEMPT_MOCK_ENABLED: "false",
  }, fetch);
  const response = await post(handler, {
    payment_session_token: "payment-session-token",
  });
  const body = await response.json();

  assertEquals(response.status, 202);
  assertEquals(body.payment_result.reason, "already_processing");
  assertEquals(fetch.calls.length, 0);
});

Deno.test("CULQI_TEST requires a valid payment session before claim", async () => {
  const fake = createFakeSupabase(
    {
      customer_email: "buyer@example.com",
      whatsapp_message: "normal commerce order",
    },
    { sessionValid: false },
  );
  const fetch = createFakeFetch({ status: 201 });
  const handler = createTestHandler(fake, {
    CREATE_PAYMENT_ATTEMPT_MODE: "culqi_test",
    CREATE_PAYMENT_ATTEMPT_MOCK_ENABLED: "false",
  }, fetch);
  const response = await post(handler, {
    payment_session_token: "payment-session-token",
  });
  const body = await response.json();

  assertEquals(response.status, 401);
  assertMatch(body.error, /sesion/i);
  assertEquals(fetch.calls.length, 0);
  assertEquals(
    fake.calls.filter((call) =>
      call.name === "claim_kafka_payment_attempt_processing"
    )
      .length,
    0,
  );
});

Deno.test("CULQI_TEST rejects revoked payment sessions before claim", async () => {
  const fake = createFakeSupabase(
    {
      customer_email: "buyer@example.com",
      whatsapp_message: "normal commerce order",
    },
    { sessionRevoked: true },
  );
  const fetch = createFakeFetch({ status: 201 });
  const handler = createTestHandler(fake, {
    CREATE_PAYMENT_ATTEMPT_MODE: "culqi_test",
    CREATE_PAYMENT_ATTEMPT_MOCK_ENABLED: "false",
  }, fetch);
  const response = await post(handler, {
    payment_session_token: "payment-session-token",
  });
  const body = await response.json();

  assertEquals(response.status, 401);
  assertMatch(body.error, /sesion/i);
  assertEquals(fetch.calls.length, 0);
  assertEquals(
    fake.calls.filter((call) =>
      call.name === "claim_kafka_payment_attempt_processing"
    )
      .length,
    0,
  );
});

Deno.test("CULQI_TEST rejects expired payment sessions before claim", async () => {
  const fake = createFakeSupabase(
    {
      customer_email: "buyer@example.com",
      whatsapp_message: "normal commerce order",
    },
    { sessionExpired: true },
  );
  const fetch = createFakeFetch({ status: 201 });
  const handler = createTestHandler(fake, {
    CREATE_PAYMENT_ATTEMPT_MODE: "culqi_test",
    CREATE_PAYMENT_ATTEMPT_MOCK_ENABLED: "false",
  }, fetch);
  const response = await post(handler, {
    payment_session_token: "payment-session-token",
  });
  const body = await response.json();

  assertEquals(response.status, 401);
  assertMatch(body.error, /sesion/i);
  assertEquals(fetch.calls.length, 0);
  assertEquals(
    fake.calls.filter((call) =>
      call.name === "claim_kafka_payment_attempt_processing"
    )
      .length,
    0,
  );
});

Deno.test("CULQI_TEST idempotent processing response does not charge again", async () => {
  const fake = createFakeSupabase({
    customer_email: "buyer@example.com",
    whatsapp_message: "normal commerce order",
  });
  const fetch = createFakeFetch({ status: 200, body: { object: "charge" } });
  const handler = createTestHandler(fake, {
    CREATE_PAYMENT_ATTEMPT_MODE: "culqi_test",
    CREATE_PAYMENT_ATTEMPT_MOCK_ENABLED: "false",
  }, fetch);

  await post(handler, { payment_session_token: "payment-session-token" });
  const response = await post(handler, {
    payment_session_token: "payment-session-token",
  });
  const body = await response.json();

  assertEquals(response.status, 202);
  assertEquals(body.payment_result.reason, "existing_attempt");
  assertEquals(fetch.calls.length, 1);
});

Deno.test("CULQI_TEST concurrent duplicate requests do not create a second charge", async () => {
  const fake = createFakeSupabase({
    customer_email: "buyer@example.com",
    whatsapp_message: "normal commerce order",
  });
  const fetch = createFakeFetch({ status: 200, body: { object: "charge" } });
  const handler = createTestHandler(fake, {
    CREATE_PAYMENT_ATTEMPT_MODE: "culqi_test",
    CREATE_PAYMENT_ATTEMPT_MOCK_ENABLED: "false",
  }, fetch);

  const [firstResponse, secondResponse] = await Promise.all([
    post(handler, { payment_session_token: "payment-session-token" }),
    post(handler, { payment_session_token: "payment-session-token" }),
  ]);
  const firstBody = await firstResponse.json();
  const secondBody = await secondResponse.json();

  assertEquals([200, 202].includes(firstResponse.status), true);
  assertEquals([200, 202].includes(secondResponse.status), true);
  assertEquals(firstBody.payment_attempt.id, secondBody.payment_attempt.id);
  assertEquals(fetch.calls.length, 1);
});

function createTestHandler(
  fake: ReturnType<typeof createFakeSupabase>,
  overrides = {},
  fetch = createFakeFetch({ status: 201 }),
) {
  const env = createEnv(overrides);

  return createHandler({
    createSupabaseClient: () => fake,
    env: (name) => env[name],
    fetch,
  });
}

function createEnv(overrides: Record<string, string>) {
  return {
    CREATE_PAYMENT_ATTEMPT_ALLOWED_ORIGINS: ORIGIN,
    CREATE_PAYMENT_ATTEMPT_MOCK_ALLOWED_STORE_ID: String(STORE_ID),
    CREATE_PAYMENT_ATTEMPT_MOCK_ENABLED: "true",
    CREATE_PAYMENT_ATTEMPT_MOCK_RESULT: "success",
    CREATE_PAYMENT_ATTEMPT_MOCK_TEST_RUNNER_SECRET: SECRET,
    ...overrides,
  } as Record<string, string>;
}

async function post(
  handler: (request: Request) => Promise<Response>,
  payloadOverrides: Record<string, unknown> = {},
  headerOverrides: Record<string, string> = {},
) {
  return await handler(
    new Request("http://localhost/functions/v1/create-payment-attempt", {
      body: JSON.stringify({
        store_id: STORE_ID,
        order_id: ORDER_ID,
        idempotency_key: "attempt-key",
        source_id: "tkn_test_sourcesafe",
        ...payloadOverrides,
      }),
      headers: {
        "Content-Type": "application/json",
        Origin: ORIGIN,
        "x-kafka-mock-test-secret": SECRET,
        ...headerOverrides,
      },
      method: "POST",
    }),
  );
}

function createFakeSupabase(
  orderOverrides: Record<string, unknown> = {},
  options: {
    claimAcquired?: boolean;
    privateKey?: string;
    sessionExpired?: boolean;
    sessionValid?: boolean;
    sessionRevoked?: boolean;
  } = {},
) {
  const order = {
    id: ORDER_ID,
    store_id: STORE_ID,
    customer_email: "payments-integration-test@example.com",
    whatsapp_message: "Kafka Payments 3B integration test - simulated data",
    status: "pending_payment",
    total_amount_cents: 1299,
    currency: "PEN",
    ...orderOverrides,
  };
  const attempts = new Map<string, Record<string, unknown>>();
  let attemptCount = 0;
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];

  function attemptResponse(attempt: Record<string, unknown>) {
    return {
      id: attempt.id,
      order_id: ORDER_ID,
      store_id: STORE_ID,
      provider: "culqi",
      environment: "test",
      status: attempt.status,
      order_status: order.status,
      amount_cents: order.total_amount_cents,
      currency: order.currency,
      culqi_charge_id: attempt.culqi_charge_id ?? null,
      failure_code: attempt.failure_code ?? null,
      failure_message: attempt.failure_message ?? null,
      provider_reference: attempt.provider_reference ?? null,
      created_at: "2026-10-13T00:00:00.000Z",
      updated_at: "2026-10-13T00:00:00.000Z",
    };
  }

  function reserveAttempt(args: Record<string, unknown>) {
    const existing = attempts.get(String(args.p_idempotency_key));
    if (existing) {
      if (existing.source_id !== args.p_culqi_source_id) {
        return {
          data: null,
          error: { message: "payment idempotency key conflict" },
          existing: true,
        };
      }

      return { data: attemptResponse(existing), error: null, existing: true };
    }

    const active = Array.from(attempts.values()).find((attempt) =>
      attempt.status === "created" || attempt.status === "processing"
    );
    if (active) {
      return {
        data: null,
        error: { message: "la orden ya tiene un intento de pago pendiente" },
        existing: false,
      };
    }

    if (order.status === "paid") {
      return {
        data: null,
        error: { message: "orden ya pagada" },
        existing: false,
      };
    }

    if (order.status === "payment_failed") {
      order.status = "pending_payment";
    }

    attemptCount += 1;
    const attempt = {
      id: `22222222-2222-4222-8222-00000000000${attemptCount}`,
      idempotency_key: args.p_idempotency_key,
      source_id: args.p_culqi_source_id,
      status: "created",
    };
    attempts.set(String(args.p_idempotency_key), attempt);
    return { data: attemptResponse(attempt), error: null, existing: false };
  }

  return {
    calls,
    from(table: string) {
      return createFakeQuery(table, order, attempts);
    },
    async rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });

      if (name === "reserve_kafka_payment_attempt") {
        const reserved = reserveAttempt(args);
        return { data: reserved.data, error: reserved.error };
      }

      if (name === "validate_order_payment_session") {
        if (
          args.p_store_id !== order.store_id ||
          args.p_order_id !== order.id ||
          options.sessionValid === false
        ) {
          return {
            data: { valid: false, reason: "invalid" },
            error: null,
          };
        }

        return {
          data: {
            expires_at: "2026-10-13T00:15:00.000Z",
            order_id: order.id,
            store_id: order.store_id,
            valid: true,
          },
          error: null,
        };
      }

      if (name === "validate_order_payment_session_and_reserve_attempt") {
        if (
          args.p_store_id !== order.store_id ||
          args.p_order_id !== order.id ||
          options.sessionValid === false
        ) {
          return {
            data: { valid: false, reason: "invalid" },
            error: null,
          };
        }

        if (options.sessionRevoked) {
          return {
            data: { valid: false, reason: "revoked" },
            error: null,
          };
        }

        if (options.sessionExpired) {
          return {
            data: { valid: false, reason: "expired" },
            error: null,
          };
        }

        const reserved = reserveAttempt(args);
        if (reserved.error) {
          return { data: null, error: reserved.error };
        }

        return {
          data: {
            existing_attempt: reserved.existing,
            order,
            payment_attempt: reserved.data,
            session: {
              expires_at: "2026-10-13T00:15:00.000Z",
              order_id: order.id,
              store_id: order.store_id,
            },
            valid: true,
          },
          error: null,
        };
      }

      if (name === "claim_kafka_payment_attempt_processing") {
        const attempt = Array.from(attempts.values()).find((item) =>
          item.id === args.p_payment_attempt_id
        );
        if (!attempt) {
          return {
            data: null,
            error: { message: "transicion de intento de pago invalida" },
          };
        }

        if (attempt.status === "processing") {
          return {
            data: {
              acquired: false,
              reason: "already_processing",
              payment_attempt: attemptResponse(attempt),
            },
            error: null,
          };
        }

        if (attempt.status === "paid" || attempt.status === "failed") {
          return {
            data: {
              acquired: false,
              reason: "terminal_state",
              payment_attempt: attemptResponse(attempt),
            },
            error: null,
          };
        }

        if (attempt.status !== "created") {
          return {
            data: null,
            error: { message: "transicion de intento de pago invalida" },
          };
        }

        if (options.claimAcquired === false) {
          attempt.status = "processing";
          return {
            data: {
              acquired: false,
              reason: "already_processing",
              payment_attempt: attemptResponse(attempt),
            },
            error: null,
          };
        }

        attempt.status = "processing";
        return {
          data: {
            acquired: true,
            reason: "claimed",
            payment_attempt: attemptResponse(attempt),
          },
          error: null,
        };
      }

      if (name === "finalize_kafka_payment_attempt") {
        const attempt = Array.from(attempts.values()).find((item) =>
          item.id === args.p_payment_attempt_id
        );
        if (!attempt || attempt.status !== "processing") {
          return {
            data: null,
            error: { message: "transicion de intento de pago invalida" },
          };
        }

        attempt.status = args.p_final_status;
        attempt.culqi_charge_id = args.p_culqi_charge_id;
        attempt.failure_code = args.p_failure_code;
        attempt.failure_message = args.p_failure_message;
        attempt.provider_reference = args.p_provider_reference;
        order.status = args.p_final_status === "paid"
          ? "paid"
          : "payment_failed";
        return { data: attemptResponse(attempt), error: null };
      }

      if (name === "get_culqi_test_private_key_for_payment") {
        if (args.p_store_id !== STORE_ID) {
          return {
            data: null,
            error: { message: "configuracion de pagos invalida" },
          };
        }

        return {
          data: options.privateKey ?? "sk_test_privatekeysafe",
          error: null,
        };
      }

      return { data: null, error: { message: `RPC no esperado: ${name}` } };
    },
  };
}

function createFakeFetch({
  body = { id: "chr_test_success123", object: "charge" },
  rejectsWithAbort = false,
  status,
}: {
  body?: Record<string, unknown>;
  rejectsWithAbort?: boolean;
  status?: number;
}) {
  const calls: Array<{ input: string | URL | Request; init?: RequestInit }> =
    [];
  const fakeFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    calls.push({ input, init });

    if (rejectsWithAbort) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }

    return new Response(JSON.stringify(body), {
      headers: { "Content-Type": "application/json" },
      status: status ?? 201,
    });
  };

  fakeFetch.calls = calls;
  return fakeFetch as typeof fetch & { calls: typeof calls };
}

function createFakeQuery(
  table: string,
  order: Record<string, unknown>,
  attempts: Map<string, Record<string, unknown>>,
) {
  const filters: Record<string, unknown> = {};

  return {
    select() {
      return this;
    },
    eq(column: string, value: unknown) {
      filters[column] = value;
      return this;
    },
    async maybeSingle() {
      if (table === "orders") {
        const match = filters.id === order.id &&
          filters.store_id === order.store_id;
        return { data: match ? order : null, error: null };
      }

      if (table === "payment_attempts") {
        const attempt = attempts.get(String(filters.idempotency_key));
        return {
          data: attempt && filters.store_id === STORE_ID
            ? { id: attempt.id }
            : null,
          error: null,
        };
      }

      return { data: null, error: { message: `Tabla no esperada: ${table}` } };
    },
  };
}

function assertNoSensitiveValues(value: unknown) {
  const serialized = JSON.stringify(value);

  assertEquals(/sk_test_/.test(serialized), false);
  assertEquals(/pk_test_/.test(serialized), false);
  assertEquals(/tkn_test_/.test(serialized), false);
}
