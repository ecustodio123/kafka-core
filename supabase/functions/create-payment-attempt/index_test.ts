import {
  assertEquals,
  assertMatch,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createHandler } from "./index.ts";
import { chargeFixture } from "../_shared/culqi-test-evidence.fixtures.ts";

const STORE_ID = 1;
const ORIGIN = "http://localhost:5173";
const SECRET = "mock-test-runner-secret-with-at-least-32-chars";
const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const DEVICE_FINGER_PRINT_ID = "8019959c-fab1-49eb-bbbe-b846d308d8df";

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
    "record_kafka_payment_attempt_uncertainty",
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
    fetch: createFakeFetch({ status: 200 }),
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

Deno.test("CULQI_TEST HTTP 200 validates session, charges once and persists uncertainty instead of paid", async () => {
  const fake = createFakeSupabase({
    customer_email: "buyer@example.com",
    whatsapp_message: "normal commerce order",
  });
  const fetch = createFakeFetch({
    status: 200,
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

  assertEquals(response.status, 202);
  assertEquals(body.payment_attempt.status, "processing");
  assertEquals(body.payment_attempt.order_status, "pending_payment");
  assertEquals(body.payment_attempt.reconciliation_required, true);
  assertEquals(body.payment_attempt.provider_reference, "chr_test_paid123");
  assertEquals(body.payment_result.mode, "culqi_test");
  assertEquals(body.payment_result.reason, "culqi_ambiguous_200");
  assertEquals(fetch.calls.length, 1);
  assertEquals(fetch.calls[0].input, "https://api.culqi.com/v2/charges");
  const requestBody = JSON.parse(String(fetch.calls[0].init?.body));
  assertEquals(
    requestBody.antifraud_details.device_finger_print_id,
    DEVICE_FINGER_PRINT_ID,
  );
  const headers = fetch.calls[0].init?.headers as Record<string, string>;
  assertEquals(
    headers.Authorization,
    "Bearer sk_test_privatekeysafe",
  );
  assertEquals(fake.calls.map((call) => call.name), [
    "validate_order_payment_session_and_reserve_attempt",
    "get_culqi_test_private_key_for_payment",
    "claim_kafka_payment_attempt_processing",
    "record_kafka_payment_attempt_uncertainty",
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

Deno.test("CULQI_TEST 200 without charge id stays processing for reconciliation", async () => {
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
  assertEquals(body.payment_result.reason, "culqi_success_without_charge_id");
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
  const fetch = createFakeFetch({ status: 200 });
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
  const fetch = createFakeFetch({ status: 200 });
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

Deno.test("CULQI_TEST recovers the same created reservation after Vault failure", async () => {
  const fake = createFakeSupabase({ customer_email: "buyer@example.com" }, {
    vaultFailuresRemaining: 1,
  });
  const fetch = createFakeFetch({
    status: 200,
    body: { id: "chr_test_recovered" },
  });
  const handler = createTestHandler(fake, {
    CREATE_PAYMENT_ATTEMPT_MODE: "culqi_test",
  }, fetch);
  const payload = { payment_session_token: "payment-session-token" };
  assertEquals((await post(handler, payload)).status, 500);
  const reserved = fake.attempts.get("attempt-key")!;
  assertEquals(reserved.status, "created");
  assertEquals(fetch.calls.length, 0);
  assertEquals(
    fake.calls.some((call) =>
      call.name === "claim_kafka_payment_attempt_processing"
    ),
    false,
  );

  const response = await post(handler, payload);
  const body = await response.json();
  assertEquals(response.status, 202);
  assertEquals(body.payment_attempt.id, reserved.id);
  assertEquals(body.payment_attempt.status, "processing");
  assertEquals(body.payment_attempt.reconciliation_required, true);
  assertEquals(fake.attempts.size, 1);
  assertEquals(fetch.calls.length, 1);
  assertNoSensitiveValues(body);
});

Deno.test("CULQI_TEST concurrent created replays reach claim but only one sends a charge", async () => {
  let arrivals = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fake = createFakeSupabase({ customer_email: "buyer@example.com" }, {
    vaultFailuresRemaining: 1,
    beforePrivateKey: async () => {
      arrivals += 1;
      if (arrivals === 2) release();
      await gate;
    },
  });
  const fetch = createFakeFetch({ status: 200 });
  const handler = createTestHandler(fake, {
    CREATE_PAYMENT_ATTEMPT_MODE: "culqi_test",
  }, fetch);
  const payload = { payment_session_token: "payment-session-token" };
  assertEquals((await post(handler, payload)).status, 500);
  const responses = await Promise.all([
    post(handler, payload),
    post(handler, payload),
  ]);
  const bodies = await Promise.all(
    responses.map((response) => response.json()),
  );
  assertEquals(arrivals, 2);
  assertEquals(
    fake.calls.filter((call) =>
      call.name === "claim_kafka_payment_attempt_processing"
    ).length,
    2,
  );
  assertEquals(bodies[0].payment_attempt.id, bodies[1].payment_attempt.id);
  assertEquals(
    bodies.every((body) => body.payment_attempt.status === "processing"),
    true,
  );
  assertEquals(
    bodies.some((body) => body.payment_result.reason === "already_processing"),
    true,
  );
  assertEquals(fetch.calls.length, 1);
  assertEquals(fake.attempts.size, 1);
});

Deno.test("CULQI_TEST created recovery preserves source, order, tenant and pricing conflicts", async () => {
  for (const mismatch of ["source", "order", "tenant", "amount", "currency"]) {
    const fake = createFakeSupabase({ customer_email: "buyer@example.com" }, {
      vaultFailuresRemaining: 1,
    });
    const fetch = createFakeFetch({ status: 200 });
    const handler = createTestHandler(fake, {
      CREATE_PAYMENT_ATTEMPT_MODE: "culqi_test",
    }, fetch);
    const payload = { payment_session_token: "payment-session-token" };
    assertEquals((await post(handler, payload)).status, 500);
    const attempt = fake.attempts.get("attempt-key")!;
    const overrides: Record<string, unknown> = {};
    if (mismatch === "source") overrides.source_id = "tkn_test_different";
    if (mismatch === "order") {
      overrides.order_id = "33333333-3333-4333-8333-333333333333";
    }
    if (mismatch === "tenant") overrides.store_id = 2;
    if (mismatch === "amount") attempt.amount_cents = 1300;
    if (mismatch === "currency") attempt.currency = "USD";
    const response = await post(handler, { ...payload, ...overrides });
    assertEquals(
      response.status,
      mismatch === "order" || mismatch === "tenant" ? 401 : 409,
    );
    assertEquals(attempt.status, "created");
    assertEquals(fetch.calls.length, 0);
    assertEquals(
      fake.calls.filter((call) =>
        call.name === "get_culqi_test_private_key_for_payment"
      ).length,
      1,
    );
    assertEquals(
      fake.calls.some((call) =>
        call.name === "claim_kafka_payment_attempt_processing"
      ),
      false,
    );
    assertNoSensitiveValues(await response.json());
  }
});

Deno.test("CULQI_TEST created recovery revalidates session and never bypasses expiry or revocation", async () => {
  for (
    const failure of [
      "sessionExpired",
      "sessionRevoked",
      "sessionValid",
    ] as const
  ) {
    const options = {
      vaultFailuresRemaining: 1,
      sessionExpired: false,
      sessionRevoked: false,
      sessionValid: true,
    };
    const fake = createFakeSupabase(
      { customer_email: "buyer@example.com" },
      options,
    );
    const fetch = createFakeFetch({ status: 200 });
    const handler = createTestHandler(fake, {
      CREATE_PAYMENT_ATTEMPT_MODE: "culqi_test",
    }, fetch);
    const payload = { payment_session_token: "payment-session-token" };
    assertEquals((await post(handler, payload)).status, 500);
    options[failure] = failure !== "sessionValid";
    assertEquals((await post(handler, payload)).status, 401);
    assertEquals(fake.attempts.get("attempt-key")!.status, "created");
    assertEquals(fetch.calls.length, 0);
    assertEquals(
      fake.calls.some((call) =>
        call.name === "claim_kafka_payment_attempt_processing"
      ),
      false,
    );
  }
});

Deno.test("CULQI_TEST replay never recovers non-created or uncertain reservations", async () => {
  for (
    const status of [
      "processing",
      "paid",
      "failed",
      "expired",
      "cancelled",
      "created",
    ]
  ) {
    const fake = createFakeSupabase({ customer_email: "buyer@example.com" }, {
      vaultFailuresRemaining: 1,
    });
    const fetch = createFakeFetch({ status: 200 });
    const handler = createTestHandler(fake, {
      CREATE_PAYMENT_ATTEMPT_MODE: "culqi_test",
    }, fetch);
    const payload = { payment_session_token: "payment-session-token" };
    assertEquals((await post(handler, payload)).status, 500);
    const attempt = fake.attempts.get("attempt-key")!;
    attempt.status = status;
    attempt.reconciliation_required = true;
    const response = await post(handler, payload);
    const body = await response.json();
    assertEquals(body.payment_attempt.status, status);
    assertEquals(body.payment_result.processed, false);
    assertEquals(fetch.calls.length, 0);
    assertEquals(
      fake.calls.filter((call) =>
        call.name === "get_culqi_test_private_key_for_payment"
      ).length,
      status === "created" ? 2 : 1,
    );
    assertEquals(
      fake.calls.filter((call) =>
        call.name === "claim_kafka_payment_attempt_processing"
      ).length,
      status === "created" ? 1 : 0,
    );
    if (status === "created") {
      assertEquals(body.payment_result.reason, "reconciliation_required");
      assertEquals("reconciliation_required" in body.payment_attempt, false);
    }
  }
});

Deno.test("CULQI_TEST reservation and claim doubles expose only the base SQL contract", async () => {
  const fake = createFakeSupabase();
  const reserved = await fake.rpc(
    "validate_order_payment_session_and_reserve_attempt",
    {
      p_store_id: STORE_ID,
      p_order_id: ORDER_ID,
      p_idempotency_key: "contract",
      p_culqi_source_id: "tkn_test_contract",
    },
  );
  assertEquals(reserved.error, null);
  const attempt =
    (reserved.data as { payment_attempt: Record<string, unknown> })
      .payment_attempt;
  const claim = await fake.rpc("claim_kafka_payment_attempt_processing", {
    p_store_id: STORE_ID,
    p_payment_attempt_id: attempt.id,
  });
  const claimed = claim.data as {
    acquired: boolean;
    payment_attempt: Record<string, unknown>;
  };
  assertEquals(claimed.acquired, true);
  for (const body of [attempt, claimed.payment_attempt]) {
    for (
      const field of [
        "reconciliation_required",
        "requires_3ds",
        "three_ds_status",
        "three_ds_completed_at",
      ]
    ) {
      assertEquals(field in body, false);
    }
  }
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

Deno.test("CULQI_TEST 201 3DS response persists 3DS metadata without finalizing paid", async () => {
  const fake = createFakeSupabase({
    customer_email: "buyer@example.com",
    whatsapp_message: "normal commerce order",
  });
  const fetch = createFakeFetch({
    status: 201,
    body: {
      id: "chr_test_requires3ds",
      object: "charge",
      amount: 1299,
      currency_code: "PEN",
      metadata: {
        kafka_store_id: String(STORE_ID),
        kafka_order_id: ORDER_ID,
        kafka_payment_attempt_id: "22222222-2222-4222-8222-000000000001",
      },
    },
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
  assertEquals(body.payment_attempt.requires_3ds, true);
  assertEquals(body.payment_attempt.three_ds_status, "required");
  assertEquals(body.payment_result.reason, "culqi_requires_3ds");
  assertEquals(
    fake.calls.filter((call) => call.name === "finalize_kafka_payment_attempt")
      .length,
    0,
  );
  assertEquals(
    fake.calls.filter((call) =>
      call.name === "mark_kafka_payment_attempt_requires_3ds"
    ).length,
    1,
  );
  assertEquals(
    fake.calls.find((call) =>
      call.name === "mark_kafka_payment_attempt_requires_3ds"
    )?.args.p_device_fingerprint_id,
    DEVICE_FINGER_PRINT_ID,
  );
  assertNoSensitiveValues(body);
  await Promise.all([
    post(handler, { payment_session_token: "payment-session-token" }),
    post(handler, { payment_session_token: "payment-session-token" }),
  ]);
  assertEquals(fetch.calls.length, 1);
  assertEquals(
    fake.calls.filter((call) =>
      call.name === "mark_kafka_payment_attempt_requires_3ds"
    ).length,
    1,
  );
});

Deno.test("CULQI_TEST unsafe or incomplete 201 identity cannot enable 3DS or bind a reference", async () => {
  const compatible = {
    id: "chr_test_requires3ds",
    object: "charge",
    amount: 1299,
    currency_code: "PEN",
    metadata: {
      kafka_store_id: String(STORE_ID),
      kafka_order_id: ORDER_ID,
      kafka_payment_attempt_id: "22222222-2222-4222-8222-000000000001",
    },
  };
  for (
    const providerBody of [
      ...[
        "chr_live_wrong",
        "chr_test_../wrong",
        " chr_test_wrong",
        "chr_test_",
        "chr_test_" + "a".repeat(152),
      ]
        .map((id) => ({ ...compatible, id })),
      { ...compatible, amount: 1 },
      { ...compatible, currency_code: "USD" },
      { ...compatible, object: "token" },
      ...["kafka_store_id", "kafka_order_id", "kafka_payment_attempt_id"]
        .map((field) => ({
          ...compatible,
          metadata: { ...compatible.metadata, [field]: "other" },
        })),
      { id: compatible.id, object: "charge" },
      { ...compatible, metadata: undefined },
      { requires_3ds: true, action_code: "REVIEW" },
      {},
    ]
  ) {
    const fake = createFakeSupabase({ customer_email: "buyer@example.com" });
    const fetch = createFakeFetch({ status: 201, body: providerBody });
    const handler = createTestHandler(fake, {
      CREATE_PAYMENT_ATTEMPT_MODE: "culqi_test",
    }, fetch);
    const response = await post(handler, {
      payment_session_token: "payment-session-token",
    });
    const body = await response.json();
    assertEquals(response.status, 202);
    assertEquals(body.payment_attempt.status, "processing");
    assertEquals(body.payment_attempt.requires_3ds, false);
    assertEquals(body.payment_attempt.provider_reference, null);
    assertEquals(body.payment_attempt.reconciliation_required, true);
    assertEquals(body.payment_result.reason, "culqi_ambiguous_201");
    assertEquals(
      fake.calls.some((call) =>
        call.name === "mark_kafka_payment_attempt_requires_3ds" ||
        call.name === "finalize_kafka_payment_attempt"
      ),
      false,
    );
    assertNoSensitiveValues(body);
    await post(handler, { payment_session_token: "payment-session-token" });
    assertEquals(fetch.calls.length, 1);
  }
});

Deno.test("CULQI_TEST incomplete 201 with uncertainty persistence failure keeps claim and never resends", async () => {
  const fake = createFakeSupabase({ customer_email: "buyer@example.com" }, {
    uncertaintyError: true,
  });
  const fetch = createFakeFetch({
    status: 201,
    body: { id: "chr_test_requires3ds" },
  });
  const handler = createTestHandler(fake, {
    CREATE_PAYMENT_ATTEMPT_MODE: "culqi_test",
  }, fetch);
  const response = await post(handler, {
    payment_session_token: "payment-session-token",
  });
  assertEquals(response.status, 503);
  assertNoSensitiveValues(await response.json());
  const replay = await post(handler, {
    payment_session_token: "payment-session-token",
  });
  assertEquals((await replay.json()).payment_attempt.status, "processing");
  assertEquals(fetch.calls.length, 1);
  assertEquals(
    fake.calls.some((call) =>
      call.name === "mark_kafka_payment_attempt_requires_3ds" ||
      call.name === "finalize_kafka_payment_attempt"
    ),
    false,
  );
});

Deno.test("CULQI_TEST requires device fingerprint before reserve and HTTP call", async () => {
  const fake = createFakeSupabase({
    customer_email: "buyer@example.com",
    whatsapp_message: "normal commerce order",
  });
  const fetch = createFakeFetch({ status: 200 });
  const handler = createTestHandler(fake, {
    CREATE_PAYMENT_ATTEMPT_MODE: "culqi_test",
    CREATE_PAYMENT_ATTEMPT_MOCK_ENABLED: "false",
  }, fetch);
  const response = await post(handler, {
    device_finger_print_id: null,
    payment_session_token: "payment-session-token",
  });
  const body = await response.json();

  assertEquals(response.status, 400);
  assertMatch(body.error, /device_finger_print_id/i);
  assertEquals(fetch.calls.length, 0);
  assertEquals(fake.calls.length, 0);
});

Deno.test("CULQI_TEST only acquired claim can call Culqi", async () => {
  const fake = createFakeSupabase(
    {
      customer_email: "buyer@example.com",
      whatsapp_message: "normal commerce order",
    },
    { claimAcquired: false },
  );
  const fetch = createFakeFetch({ status: 200 });
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
  const fetch = createFakeFetch({ status: 200 });
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
  const fetch = createFakeFetch({ status: 200 });
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
  const fetch = createFakeFetch({ status: 200 });
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
  fetch = createFakeFetch({ status: 200 }),
) {
  const env = createEnv(overrides);

  return createHandler({
    createSupabaseClient: () => fake,
    env: (name) => env[name],
    fetch,
  });
}

Deno.test("CULQI_TEST persists timeout and never repeats the charge on replay", async () => {
  const fake = createFakeSupabase({ customer_email: "buyer@example.com" });
  const fetch = createFakeFetch({ rejectsWithAbort: true });
  const handler = createTestHandler(fake, {
    CREATE_PAYMENT_ATTEMPT_MODE: "culqi_test",
  }, fetch);
  const response = await post(handler, {
    payment_session_token: "payment-session-token",
  });
  const body = await response.json();
  assertEquals(body.payment_attempt.reconciliation_required, true);
  assertEquals(fake.calls.at(-1)?.args.p_reason, "culqi_timeout");
  await post(handler, { payment_session_token: "payment-session-token" });
  assertEquals(fetch.calls.length, 1);
  assertEquals(
    fake.calls.filter((c) =>
      c.name === "record_kafka_payment_attempt_uncertainty"
    ).length,
    1,
  );
});

Deno.test("CULQI_TEST reports persistence failure without retrying HTTP", async () => {
  const fake = createFakeSupabase({ customer_email: "buyer@example.com" }, {
    uncertaintyError: true,
  });
  const fetch = createFakeFetch({ rejectsWithAbort: true });
  const handler = createTestHandler(fake, {
    CREATE_PAYMENT_ATTEMPT_MODE: "culqi_test",
  }, fetch);
  const response = await post(handler, {
    payment_session_token: "payment-session-token",
  });
  assertEquals(response.status, 503);
  assertNoSensitiveValues(await response.json());
  await post(handler, { payment_session_token: "payment-session-token" });
  assertEquals(fetch.calls.length, 1);
});

Deno.test("CULQI_TEST preserves a candidate reference without attempting financial finalization", async () => {
  const fake = createFakeSupabase({ customer_email: "buyer@example.com" }, {
    finalizeError: true,
  });
  const fetch = createFakeFetch({
    status: 200,
    body: { id: "chr_test_savedreference", object: "charge" },
  });
  const handler = createTestHandler(fake, {
    CREATE_PAYMENT_ATTEMPT_MODE: "culqi_test",
  }, fetch);
  const response = await post(handler, {
    payment_session_token: "payment-session-token",
  });
  const body = await response.json();
  assertEquals(response.status, 202);
  assertEquals(body.payment_attempt.status, "processing");
  assertEquals(body.payment_attempt.reconciliation_required, true);
  assertEquals(
    body.payment_attempt.provider_reference,
    "chr_test_savedreference",
  );
  assertEquals(fake.calls.at(-1)?.args.p_reason, "culqi_ambiguous_200");
  assertEquals(
    fake.calls.some((call) => call.name === "finalize_kafka_payment_attempt"),
    false,
  );
  assertEquals(fetch.calls.length, 1);
});

Deno.test("CULQI_TEST complete, contradictory, incomplete and 3DS-shaped 200 evidence never finalizes", async () => {
  const complete = chargeFixture({
    amount: 1299,
    current_amount: 1299,
    paid: true,
    metadata: {
      kafka_store_id: String(STORE_ID),
      kafka_order_id: ORDER_ID,
      kafka_payment_attempt_id: "22222222-2222-4222-8222-000000000001",
    },
  });
  for (
    const providerBody of [
      complete,
      { ...complete, amount: 1 },
      { ...complete, currency_code: "USD" },
      { ...complete, metadata: { ...complete.metadata, kafka_store_id: "2" } },
      {
        ...complete,
        metadata: { ...complete.metadata, kafka_order_id: "other" },
      },
      {
        ...complete,
        metadata: { ...complete.metadata, kafka_payment_attempt_id: "other" },
      },
      { ...complete, object: "token" },
      { ...complete, id: "chr_live_invalid" },
      { id: complete.id },
      {},
      { action_code: "REVIEW", requires_3ds: true },
    ]
  ) {
    const fake = createFakeSupabase({ customer_email: "buyer@example.com" });
    const fetch = createFakeFetch({ status: 200, body: providerBody });
    const handler = createTestHandler(fake, {
      CREATE_PAYMENT_ATTEMPT_MODE: "culqi_test",
    }, fetch);
    const response = await post(handler, {
      payment_session_token: "payment-session-token",
    });
    const body = await response.json();
    assertEquals(response.status, 202);
    assertEquals(body.payment_attempt.status, "processing");
    assertEquals(body.payment_attempt.order_status, "pending_payment");
    assertEquals(body.payment_attempt.reconciliation_required, true);
    assertEquals(
      fake.calls.some((call) => call.name === "finalize_kafka_payment_attempt"),
      false,
    );
    const contradictory = "amount" in providerBody &&
      (providerBody.amount !== 1299 || providerBody.currency_code !== "PEN");
    // A mismatched amount must never bind a provider reference to this attempt.
    if (contradictory) {
      assertEquals(body.payment_attempt.provider_reference, null);
    }
    if (providerBody === complete) {
      assertEquals(body.payment_attempt.provider_reference, complete.id);
    }
    assertNoSensitiveValues(body);
    await post(handler, { payment_session_token: "payment-session-token" });
    assertEquals(fetch.calls.length, 1);
  }
});

Deno.test("CULQI_TEST unverified 200 persistence failure never finalizes or resends", async () => {
  const fake = createFakeSupabase({ customer_email: "buyer@example.com" }, {
    uncertaintyError: true,
  });
  const fetch = createFakeFetch({ status: 200 });
  const handler = createTestHandler(fake, {
    CREATE_PAYMENT_ATTEMPT_MODE: "culqi_test",
  }, fetch);
  const response = await post(handler, {
    payment_session_token: "payment-session-token",
  });
  assertEquals(response.status, 503);
  assertNoSensitiveValues(await response.json());
  await post(handler, { payment_session_token: "payment-session-token" });
  assertEquals(fetch.calls.length, 1);
  assertEquals(
    fake.calls.some((call) => call.name === "finalize_kafka_payment_attempt"),
    false,
  );
});

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

Deno.test("CULQI_TEST late rejection reports the already-paid database result", async () => {
  const fake = createFakeSupabase({ customer_email: "buyer@example.com" }, {
    finalizeReturnsPaid: true,
  });
  const fetch = createFakeFetch({
    status: 402,
    body: {
      type: "card_error",
      code: "card_declined",
      decline_code: "insufficient_funds",
    },
  });
  const response = await post(
    createTestHandler(
      fake,
      { CREATE_PAYMENT_ATTEMPT_MODE: "culqi_test" },
      fetch,
    ),
    {
      payment_session_token: "payment-session-token",
    },
  );
  const body = await response.json();
  assertEquals(response.status, 200);
  assertEquals(body.payment_attempt.status, "paid");
  assertEquals(body.payment_result.reason, "already_finalized");
  assertEquals(fetch.calls.length, 1);
});

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
        device_finger_print_id: DEVICE_FINGER_PRINT_ID,
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
    uncertaintyError?: boolean;
    finalizeError?: boolean;
    finalizeReturnsPaid?: boolean;
    claimAcquired?: boolean;
    privateKey?: string;
    vaultFailuresRemaining?: number;
    beforePrivateKey?: () => Promise<void>;
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

  function threeDsResponse(attempt: Record<string, unknown>) {
    return {
      ...attemptResponse(attempt),
      requires_3ds: attempt.requires_3ds ?? false,
      three_ds_status: attempt.three_ds_status ?? null,
      reconciliation_required: attempt.reconciliation_required ?? false,
    };
  }

  function reconciliationResponse(attempt: Record<string, unknown>) {
    return {
      ...threeDsResponse(attempt),
      three_ds_completed_at: attempt.three_ds_completed_at ?? null,
    };
  }

  function reserveAttempt(args: Record<string, unknown>) {
    const existing = attempts.get(String(args.p_idempotency_key));
    if (existing) {
      if (
        existing.source_id !== args.p_culqi_source_id ||
        existing.amount_cents !== order.total_amount_cents ||
        existing.currency !== order.currency
      ) {
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
      amount_cents: order.total_amount_cents,
      currency: order.currency,
      status: "created",
    };
    attempts.set(String(args.p_idempotency_key), attempt);
    return { data: attemptResponse(attempt), error: null, existing: false };
  }

  return {
    calls,
    attempts,
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

        if (
          ["paid", "failed", "expired", "cancelled"].includes(
            String(attempt.status),
          )
        ) {
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

        if (attempt.reconciliation_required === true) {
          return {
            data: {
              acquired: false,
              reason: "reconciliation_required",
              payment_attempt: attemptResponse(attempt),
            },
            error: null,
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

      if (name === "record_kafka_payment_attempt_uncertainty") {
        if (options.uncertaintyError) {
          return {
            data: null,
            error: { message: "TEST persistence unavailable" },
          };
        }
        const attempt = Array.from(attempts.values()).find((item) =>
          item.id === args.p_payment_attempt_id
        );
        if (!attempt) {
          return { data: null, error: { message: "invalid uncertainty" } };
        }
        attempt.reconciliation_required = true;
        attempt.reconciliation_reason = args.p_reason;
        if (args.p_provider_reference) {
          attempt.provider_reference = args.p_provider_reference;
        }
        return { data: reconciliationResponse(attempt), error: null };
      }

      if (name === "finalize_kafka_payment_attempt") {
        if (options.finalizeError) {
          return {
            data: null,
            error: { message: "TEST finalization unavailable" },
          };
        }
        const attempt = Array.from(attempts.values()).find((item) =>
          item.id === args.p_payment_attempt_id
        );
        if (!attempt || attempt.status !== "processing") {
          return {
            data: null,
            error: { message: "transicion de intento de pago invalida" },
          };
        }

        attempt.status = options.finalizeReturnsPaid
          ? "paid"
          : args.p_final_status;
        attempt.culqi_charge_id = args.p_culqi_charge_id;
        attempt.failure_code = args.p_failure_code;
        attempt.failure_message = args.p_failure_message;
        attempt.provider_reference = args.p_provider_reference;
        attempt.reconciliation_required = false;
        order.status = attempt.status === "paid" ? "paid" : "payment_failed";
        return { data: reconciliationResponse(attempt), error: null };
      }

      if (name === "mark_kafka_payment_attempt_requires_3ds") {
        const attempt = Array.from(attempts.values()).find((item) =>
          item.id === args.p_payment_attempt_id
        );
        if (!attempt || attempt.status !== "processing") {
          return {
            data: null,
            error: { message: "intento de pago inconsistente con la orden" },
          };
        }

        attempt.requires_3ds = true;
        attempt.three_ds_status = "required";
        attempt.provider_reference = args.p_provider_reference;
        attempt.reconciliation_required = false;
        return { data: threeDsResponse(attempt), error: null };
      }

      if (name === "get_culqi_test_private_key_for_payment") {
        if ((options.vaultFailuresRemaining ?? 0) > 0) {
          options.vaultFailuresRemaining! -= 1;
          return { data: null, error: { message: "TEST Vault unavailable" } };
        }
        await options.beforePrivateKey?.();
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
