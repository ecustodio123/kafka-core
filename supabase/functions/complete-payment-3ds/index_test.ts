import {
  assertEquals,
  assertMatch,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createHandler } from "./index.ts";

const STORE_ID = 1;
const ORIGIN = "http://localhost:5173";
const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const ATTEMPT_ID = "22222222-2222-4222-8222-222222222222";
const DEVICE_FINGER_PRINT_ID = "8019959c-fab1-49eb-bbbe-b846d308d8df";
const PAYMENT_SESSION_TOKEN = "session-token-safe";
const SOURCE_ID = "tkn_test_sourcesafe";
const CAVV = "CAVV_SAFE_TEST_VALUE";
const XID = "XID_SAFE_TEST_VALUE";

Deno.test("3DS success validates source, claims once and finalizes paid", async () => {
  const fake = createFakeSupabase();
  const fetch = createFakeFetch({
    body: { id: "chr_test_3dspaid123", object: "charge" },
    status: 200,
  });
  const handler = createTestHandler(fake, fetch);

  const response = await post(handler);
  const body = await response.json();

  assertEquals(response.status, 201);
  assertEquals(body.payment_attempt.status, "paid");
  assertEquals(body.payment_attempt.order_status, "paid");
  assertEquals(body.payment_result.reason, "culqi_3ds_charge_paid");
  assertEquals(body.payment_attempt.three_ds_status, "completion_processing");
  assertEquals(body.payment_attempt.reconciliation_required, true);
  assertEquals(
    (fake.calls[fake.calls.length - 1].args.p_sanitized_payload as Record<
      string,
      unknown
    >)
      .three_ds_authenticated,
    undefined,
  );
  assertEquals(fetch.calls.length, 1);
  assertEquals(fetch.calls[0].input, "https://api.culqi.com/v2/charges");

  const requestBody = JSON.parse(String(fetch.calls[0].init?.body));
  assertEquals(requestBody.source_id, SOURCE_ID);
  assertEquals(
    requestBody.antifraud_details.device_finger_print_id,
    DEVICE_FINGER_PRINT_ID,
  );
  assertEquals(requestBody.authentication_3DS.cavv, CAVV);
  assertEquals(requestBody.amount, 1299);
  assertEquals(requestBody.currency_code, "PEN");
  assertEquals(fake.calls.map((call) => call.name), [
    "validate_payment_attempt_source",
    "get_culqi_test_private_key_for_payment",
    "claim_kafka_payment_attempt_3ds_completion",
    "finalize_kafka_payment_attempt",
  ]);
  assertNoSensitiveValues(body);
});

Deno.test("3DS definitive rejection finalizes failed only for confirmed card declines", async () => {
  const fake = createFakeSupabase();
  const fetch = createFakeFetch({
    body: {
      code: "card_declined",
      decline_code: "insufficient_funds",
      merchant_message: "Card declined",
      type: "card_error",
    },
    status: 402,
  });
  const handler = createTestHandler(fake, fetch);

  const response = await post(handler);
  const body = await response.json();

  assertEquals(response.status, 402);
  assertEquals(body.payment_attempt.status, "failed");
  assertEquals(body.payment_attempt.order_status, "payment_failed");
  assertEquals(body.payment_attempt.failure_code, "insufficient_funds");
  assertEquals(body.payment_result.reason, "culqi_3ds_definitive_failure");
  assertEquals(body.payment_attempt.three_ds_status, "completion_processing");
  assertEquals(body.payment_attempt.reconciliation_required, true);
  assertEquals(
    (fake.calls[fake.calls.length - 1].args.p_sanitized_payload as Record<
      string,
      unknown
    >)
      .three_ds_authenticated,
    undefined,
  );
  assertNoSensitiveValues(body);
});

Deno.test("HTTP 200 and browser 3DS data do not prove authentication", async () => {
  const fake = createFakeSupabase();
  const fetch = createFakeFetch({
    status: 200,
    body: {
      id: "chr_test_noproof",
      object: "charge",
      three_ds_authenticated: true,
      authentication_3DS: authentication3ds(),
    },
  });
  const response = await post(createTestHandler(fake, fetch), {
    authentication_3DS: { ...authentication3ds(), eci: "07" },
  });
  const body = await response.json();
  assertEquals(body.payment_attempt.status, "paid");
  assertEquals(body.payment_attempt.three_ds_status, "completion_processing");
  assertEquals(body.payment_attempt.reconciliation_required, true);
  const diagnostic = fake.calls[fake.calls.length - 1].args
    .p_sanitized_payload as Record<string, unknown>;
  assertEquals(diagnostic.culqi_status, 200);
  assertEquals("three_ds_authenticated" in diagnostic, false);
  assertEquals("authentication_3DS" in diagnostic, false);
  assertNoSensitiveValues(body);
});

Deno.test("3DS ambiguous 400 keeps processing for reconciliation", async () => {
  const fake = createFakeSupabase();
  const fetch = createFakeFetch({
    body: {
      code: "parameter_invalid",
      message: "Invalid request",
      type: "invalid_request_error",
    },
    status: 400,
  });
  const handler = createTestHandler(fake, fetch);

  const response = await post(handler);
  const body = await response.json();

  assertEquals(response.status, 202);
  assertEquals(body.payment_attempt.status, "processing");
  assertEquals(body.payment_result.reason, "culqi_3ds_ambiguous_400");
  assertEquals(body.payment_result.requires_reconciliation, true);
  assertEquals(
    fake.calls.filter((call) => call.name === "finalize_kafka_payment_attempt")
      .length,
    0,
  );
});

Deno.test("3DS timeout keeps processing and does not finalize", async () => {
  const fake = createFakeSupabase();
  const fetch = createFakeFetch({ rejectsWithAbort: true });
  const handler = createTestHandler(fake, fetch);

  const response = await post(handler);
  const body = await response.json();

  assertEquals(response.status, 202);
  assertEquals(body.payment_attempt.status, "processing");
  assertEquals(body.payment_result.reason, "culqi_3ds_timeout");
  assertEquals(
    fake.calls.filter((call) => call.name === "finalize_kafka_payment_attempt")
      .length,
    0,
  );
});

Deno.test("3DS repeated request after claim does not send a second Culqi charge", async () => {
  const fake = createFakeSupabase();
  const fetch = createFakeFetch({
    body: { id: "chr_test_withoutfinalization", object: "charge" },
    status: 201,
  });
  const handler = createTestHandler(fake, fetch);

  const firstResponse = await post(handler);
  const secondResponse = await post(handler);
  const firstBody = await firstResponse.json();
  const secondBody = await secondResponse.json();

  assertEquals(firstResponse.status, 202);
  assertEquals(secondResponse.status, 202);
  assertEquals(firstBody.payment_attempt.id, secondBody.payment_attempt.id);
  assertEquals(secondBody.payment_result.processed, false);
  assertEquals(secondBody.payment_result.reason, "already_processing");
  assertEquals(fetch.calls.length, 1);
});

Deno.test("3DS concurrent duplicate requests acquire only one claim", async () => {
  const fake = createFakeSupabase();
  const fetch = createFakeFetch({
    body: { id: "chr_test_slowambiguous", object: "charge" },
    delayMs: 10,
    status: 201,
  });
  const handler = createTestHandler(fake, fetch);

  const [firstResponse, secondResponse] = await Promise.all([
    post(handler),
    post(handler),
  ]);
  const firstBody = await firstResponse.json();
  const secondBody = await secondResponse.json();

  assertEquals([202].includes(firstResponse.status), true);
  assertEquals([202].includes(secondResponse.status), true);
  assertEquals(firstBody.payment_attempt.id, secondBody.payment_attempt.id);
  assertEquals(fetch.calls.length, 1);
  assertEquals(
    fake.calls.filter((call) =>
      call.name === "claim_kafka_payment_attempt_3ds_completion"
    ).length,
    2,
  );
});

Deno.test("3DS invalid session is rejected before source validation, claim or HTTP call", async () => {
  const fake = createFakeSupabase({ sessionStatus: "revoked" });
  const fetch = createFakeFetch({ status: 200 });
  const handler = createTestHandler(fake, fetch);

  const response = await post(handler);
  const body = await response.json();

  assertEquals(response.status, 401);
  assertMatch(body.error, /sesion/i);
  assertEquals(fake.calls.length, 0);
  assertEquals(fetch.calls.length, 0);
});

Deno.test("3DS expired session is rejected because recovery is only for status polling", async () => {
  const fake = createFakeSupabase({ sessionStatus: "expired" });
  const fetch = createFakeFetch({ status: 200 });
  const handler = createTestHandler(fake, fetch);

  const response = await post(handler);
  const body = await response.json();

  assertEquals(response.status, 401);
  assertMatch(body.error, /sesion/i);
  assertEquals(fetch.calls.length, 0);
});

Deno.test("3DS active session with past expires_at is rejected", async () => {
  const fake = createFakeSupabase({
    sessionExpiresAt: "2026-10-13T00:04:59.000Z",
  });
  const fetch = createFakeFetch({ status: 200 });
  const handler = createTestHandler(fake, fetch);

  const response = await post(handler);
  const body = await response.json();

  assertEquals(response.status, 401);
  assertMatch(body.error, /sesion/i);
  assertEquals(fetch.calls.length, 0);
});

Deno.test("3DS rejects attempts from another store", async () => {
  const fake = createFakeSupabase({ attemptStoreId: 2 });
  const fetch = createFakeFetch({ status: 200 });
  const handler = createTestHandler(fake, fetch);

  const response = await post(handler);
  const body = await response.json();

  assertEquals(response.status, 404);
  assertMatch(body.error, /intento/i);
  assertEquals(fetch.calls.length, 0);
});

Deno.test("3DS rejects source mismatches before claim and HTTP call", async () => {
  const fake = createFakeSupabase({ sourceId: "tkn_test_originalsafe" });
  const fetch = createFakeFetch({ status: 200 });
  const handler = createTestHandler(fake, fetch);

  const response = await post(handler);
  const body = await response.json();

  assertEquals(response.status, 409);
  assertMatch(body.error, /validacion/i);
  assertEquals(fetch.calls.length, 0);
  assertEquals(
    fake.calls.filter((call) =>
      call.name === "claim_kafka_payment_attempt_3ds_completion"
    ).length,
    0,
  );
});

Deno.test("3DS claim refusal never contacts Culqi", async () => {
  const fake = createFakeSupabase({ claimAcquired: false });
  const fetch = createFakeFetch({ status: 200 });
  const handler = createTestHandler(fake, fetch);

  const response = await post(handler);
  const body = await response.json();

  assertEquals(response.status, 202);
  assertEquals(body.payment_result.reason, "already_processing");
  assertEquals(fetch.calls.length, 0);
});

Deno.test("3DS missing attempt is rejected without reserving anything", async () => {
  const fake = createFakeSupabase({ attemptMissing: true });
  const fetch = createFakeFetch({ status: 200 });
  const response = await post(createTestHandler(fake, fetch));
  assertEquals(response.status, 404);
  assertEquals(fake.calls.length, 0);
  assertEquals(fetch.calls.length, 0);
});

for (const status of ["created", "failed", "expired", "cancelled"]) {
  Deno.test(`3DS rejects attempt state ${status} before claim`, async () => {
    const fake = createFakeSupabase({ attemptStatus: status });
    const fetch = createFakeFetch({ status: 200 });
    const response = await post(createTestHandler(fake, fetch));
    assertEquals(response.status, 409);
    assertEquals(fake.calls.length, 0);
    assertEquals(fetch.calls.length, 0);
  });
}

Deno.test("3DS requires literal true from source validator", async () => {
  for (const sourceValidationResult of [false, "true", { valid: true }]) {
    const fake = createFakeSupabase({ sourceValidationResult });
    const fetch = createFakeFetch({ status: 200 });
    const response = await post(createTestHandler(fake, fetch));
    assertEquals(response.status, 409);
    assertEquals(fake.calls.map((call) => call.name), [
      "validate_payment_attempt_source",
    ]);
    assertEquals(fetch.calls.length, 0);
  }
});

Deno.test("3DS invalid authentication payload is rejected before database access", async () => {
  const fake = createFakeSupabase();
  const fetch = createFakeFetch({ status: 200 });
  const handler = createTestHandler(fake, fetch);

  const response = await post(handler, {
    authentication_3DS: {
      ...authentication3ds(),
      card_number: "4111111111111111",
    },
  });
  const body = await response.json();

  assertEquals(response.status, 400);
  assertMatch(body.error, /authentication_3DS/i);
  assertEquals(fake.calls.length, 0);
  assertEquals(fetch.calls.length, 0);
});

Deno.test("3DS disabled configuration stops before database access", async () => {
  const fake = createFakeSupabase();
  const fetch = createFakeFetch({ status: 200 });
  const handler = createTestHandler(fake, fetch, {
    COMPLETE_PAYMENT_3DS_ENABLED: "false",
  });

  const response = await post(handler);
  const body = await response.json();

  assertEquals(response.status, 400);
  assertMatch(body.error, /habilitado/i);
  assertEquals(fake.calls.length, 0);
  assertEquals(fetch.calls.length, 0);
});

function createTestHandler(
  fake: ReturnType<typeof createFakeSupabase>,
  fetch = createFakeFetch({ status: 200 }),
  overrides: Record<string, string> = {},
) {
  const env = createEnv(overrides);

  return createHandler({
    createSupabaseClient: () => fake,
    env: (name) => env[name],
    fetch,
    now: () => new Date("2026-10-13T00:05:00.000Z"),
  });
}

function createEnv(overrides: Record<string, string>) {
  return {
    COMPLETE_PAYMENT_3DS_ALLOWED_ORIGINS: ORIGIN,
    COMPLETE_PAYMENT_3DS_ENABLED: "true",
    COMPLETE_PAYMENT_3DS_MODE: "culqi_test",
    ...overrides,
  } as Record<string, string>;
}

async function post(
  handler: (request: Request) => Promise<Response>,
  payloadOverrides: Record<string, unknown> = {},
) {
  return await handler(
    new Request("http://localhost/functions/v1/complete-payment-3ds", {
      body: JSON.stringify({
        store_id: STORE_ID,
        order_id: ORDER_ID,
        payment_attempt_id: ATTEMPT_ID,
        payment_session_token: PAYMENT_SESSION_TOKEN,
        source_id: SOURCE_ID,
        device_finger_print_id: DEVICE_FINGER_PRINT_ID,
        authentication_3DS: authentication3ds(),
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

function authentication3ds() {
  return {
    eci: "05",
    xid: XID,
    cavv: CAVV,
    protocolVersion: "2.2.0",
    directoryServerTransactionId: "99999999-9999-4999-8999-999999999999",
  };
}

Deno.test("3DS late rejection reports the already-paid database result", async () => {
  const fake = createFakeSupabase({ finalizeReturnsPaid: true });
  const fetch = createFakeFetch({
    status: 402,
    body: {
      type: "card_error",
      code: "card_declined",
      decline_code: "insufficient_funds",
    },
  });
  const response = await post(createTestHandler(fake, fetch));
  const body = await response.json();
  assertEquals(response.status, 200);
  assertEquals(body.payment_attempt.status, "paid");
  assertEquals(body.payment_result.reason, "already_finalized");
  assertEquals(body.payment_attempt.reconciliation_required, true);
  assertEquals(fetch.calls.length, 1);
});

Deno.test("3DS timeout persistence survives replay without another charge", async () => {
  const fake = createFakeSupabase();
  const fetch = createFakeFetch({ rejectsWithAbort: true });
  const handler = createTestHandler(fake, fetch);
  const response = await post(handler);
  const body = await response.json();
  assertEquals(body.payment_attempt.reconciliation_required, true);
  assertEquals(fake.calls.at(-1)?.args.p_reason, "culqi_3ds_timeout");
  await post(handler);
  assertEquals(fetch.calls.length, 1);
  assertEquals(
    fake.calls.filter((c) =>
      c.name === "record_kafka_payment_attempt_uncertainty"
    ).length,
    1,
  );
});

Deno.test("3DS failed finalization persists the confirmed charge reference", async () => {
  const fake = createFakeSupabase({ finalizeError: true });
  const fetch = createFakeFetch({
    status: 200,
    body: { id: "chr_test_3dsreference", object: "charge" },
  });
  const handler = createTestHandler(fake, fetch);
  const response = await post(handler);
  const body = await response.json();
  assertEquals(response.status, 202);
  assertEquals(
    body.payment_attempt.provider_reference,
    "chr_test_3dsreference",
  );
  assertEquals(body.payment_attempt.status, "processing");
  assertEquals(fake.calls.at(-1)?.args.p_reason, "culqi_3ds_finalize_failed");
  await post(handler);
  assertEquals(fetch.calls.length, 1);
});

Deno.test("3DS persistence failure returns a safe error and does not release the claim", async () => {
  const fake = createFakeSupabase({ uncertaintyError: true });
  const fetch = createFakeFetch({ rejectsWithAbort: true });
  const handler = createTestHandler(fake, fetch);
  const response = await post(handler);
  assertEquals(response.status, 503);
  assertNoSensitiveValues(await response.json());
  await post(handler);
  assertEquals(fetch.calls.length, 1);
});

function createFakeSupabase(options: {
  uncertaintyError?: boolean;
  finalizeError?: boolean;
  finalizeReturnsPaid?: boolean;
  attemptMissing?: boolean;
  attemptStatus?: string;
  sourceValidationResult?: unknown;
  attemptStoreId?: number;
  claimAcquired?: boolean;
  orderStatus?: string;
  privateKey?: string;
  sessionCreatedAt?: string;
  sessionExpiresAt?: string;
  sessionStatus?: string;
  sourceId?: string;
} = {}) {
  const order = {
    id: ORDER_ID,
    store_id: STORE_ID,
    customer_email: "buyer@example.com",
    status: options.orderStatus ?? "pending_payment",
    total_amount_cents: 1299,
    currency: "PEN",
  };
  const attempt: Record<string, unknown> = {
    id: ATTEMPT_ID,
    order_id: ORDER_ID,
    store_id: options.attemptStoreId ?? STORE_ID,
    provider: "culqi",
    environment: "test",
    status: options.attemptStatus ?? "processing",
    amount_cents: 1299,
    currency: "PEN",
    idempotency_key: "attempt-key",
    source_id: options.sourceId ?? SOURCE_ID,
    culqi_charge_id: null,
    failure_code: null,
    failure_message: null,
    provider_reference: "chr_test_requires3ds",
    requires_3ds: true,
    three_ds_status: "required",
    reconciliation_required: false,
    created_at: "2026-10-13T00:00:00.000Z",
    updated_at: "2026-10-13T00:00:00.000Z",
  };
  const session = {
    store_id: STORE_ID,
    order_id: ORDER_ID,
    status: options.sessionStatus ?? "active",
    expires_at: options.sessionExpiresAt ?? "2026-10-13T00:15:00.000Z",
    created_at: options.sessionCreatedAt ?? "2026-10-13T00:00:00.000Z",
  };
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];

  function attemptResponse() {
    return {
      id: attempt.id,
      order_id: attempt.order_id,
      store_id: attempt.store_id,
      provider: attempt.provider,
      environment: attempt.environment,
      status: attempt.status,
      order_status: order.status,
      amount_cents: attempt.amount_cents,
      currency: attempt.currency,
      culqi_charge_id: attempt.culqi_charge_id,
      failure_code: attempt.failure_code,
      failure_message: attempt.failure_message,
      provider_reference: attempt.provider_reference,
      requires_3ds: attempt.requires_3ds,
      three_ds_status: attempt.three_ds_status,
      reconciliation_required: attempt.reconciliation_required,
      created_at: attempt.created_at,
      updated_at: attempt.updated_at,
    };
  }

  return {
    calls,
    from(table: string) {
      return createFakeQuery(
        table,
        { attempt, order, session },
        options.attemptMissing,
      );
    },
    async rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });

      if (name === "validate_payment_attempt_source") {
        if (
          args.p_store_id !== attempt.store_id ||
          args.p_payment_attempt_id !== attempt.id ||
          args.p_culqi_source_id !== attempt.source_id ||
          attempt.status !== "processing"
        ) {
          return {
            data: null,
            error: { message: "validacion de intento de pago invalida" },
          };
        }

        return { data: options.sourceValidationResult ?? true, error: null };
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

      if (name === "claim_kafka_payment_attempt_3ds_completion") {
        if (
          args.p_payment_attempt_id !== attempt.id ||
          args.p_device_fingerprint_id !== DEVICE_FINGER_PRINT_ID ||
          attempt.three_ds_status !== "required"
        ) {
          return {
            data: {
              acquired: false,
              reason: "already_processing",
              payment_attempt: attemptResponse(),
            },
            error: null,
          };
        }

        if (options.claimAcquired === false) {
          attempt.three_ds_status = "completion_processing";
          attempt.reconciliation_required = true;
          return {
            data: {
              acquired: false,
              reason: "already_processing",
              payment_attempt: attemptResponse(),
            },
            error: null,
          };
        }

        attempt.three_ds_status = "completion_processing";
        attempt.reconciliation_required = true;
        return {
          data: {
            acquired: true,
            reason: "claimed",
            payment_attempt: attemptResponse(),
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
        attempt.reconciliation_required = true;
        attempt.reconciliation_reason = args.p_reason;
        if (args.p_provider_reference) {
          attempt.provider_reference = args.p_provider_reference;
        }
        return { data: attemptResponse(), error: null };
      }

      if (name === "finalize_kafka_payment_attempt") {
        if (options.finalizeError) {
          return {
            data: null,
            error: { message: "TEST finalization unavailable" },
          };
        }
        if (attempt.status !== "processing") {
          return {
            data: null,
            error: { message: "transicion de intento de pago invalida" },
          };
        }

        attempt.status = options.finalizeReturnsPaid
          ? "paid"
          : String(args.p_final_status);
        attempt.culqi_charge_id = args.p_culqi_charge_id as string | null;
        attempt.failure_code = args.p_failure_code as string | null;
        attempt.failure_message = args.p_failure_message as string | null;
        attempt.provider_reference = args.p_provider_reference as string | null;
        // Finalizing a charge does not verify the authentication outcome.
        attempt.reconciliation_required = true;
        order.status = attempt.status === "paid" ? "paid" : "payment_failed";
        return { data: attemptResponse(), error: null };
      }

      return { data: null, error: { message: `RPC no esperado: ${name}` } };
    },
  };
}

function createFakeQuery(
  table: string,
  records: {
    attempt: Record<string, unknown>;
    order: Record<string, unknown>;
    session: Record<string, unknown>;
  },
  attemptMissing = false,
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
      if (table === "order_payment_sessions") {
        const match = filters.store_id === records.session.store_id &&
          filters.order_id === records.session.order_id;
        return { data: match ? records.session : null, error: null };
      }

      if (table === "orders") {
        const match = filters.store_id === records.order.store_id &&
          filters.id === records.order.id;
        return { data: match ? records.order : null, error: null };
      }

      if (table === "payment_attempts") {
        const match = !attemptMissing &&
          filters.store_id === records.attempt.store_id &&
          filters.order_id === records.attempt.order_id &&
          filters.id === records.attempt.id;
        return { data: match ? records.attempt : null, error: null };
      }

      return { data: null, error: { message: `Tabla no esperada: ${table}` } };
    },
  };
}

function createFakeFetch({
  body = { id: "chr_test_success123", object: "charge" },
  delayMs = 0,
  rejectsWithAbort = false,
  status,
}: {
  body?: Record<string, unknown>;
  delayMs?: number;
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

    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    if (rejectsWithAbort) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }

    return new Response(JSON.stringify(body), {
      headers: { "Content-Type": "application/json" },
      status: status ?? 200,
    });
  };

  fakeFetch.calls = calls;
  return fakeFetch as typeof fetch & { calls: typeof calls };
}

function assertNoSensitiveValues(value: unknown) {
  const serialized = JSON.stringify(value);

  assertEquals(/sk_test_/.test(serialized), false);
  assertEquals(/pk_test_/.test(serialized), false);
  assertEquals(/tkn_test_/.test(serialized), false);
  assertEquals(serialized.includes(PAYMENT_SESSION_TOKEN), false);
  assertEquals(serialized.includes(CAVV), false);
  assertEquals(serialized.includes(XID), false);
}
