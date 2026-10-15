import {
  assertEquals,
  assertMatch,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createHandler as createOrderHandler } from "./create-order/index.ts";
import { createHandler as createPaymentAttemptHandler } from "./create-payment-attempt/index.ts";

const ORIGIN = "http://localhost:5173";
const STORE_ID = 1;
const NOW = new Date("2026-10-13T12:00:00.000Z");
const DEVICE_FINGER_PRINT_ID = "8019959c-fab1-49eb-bbbe-b846d308d8df";

Deno.test("3C.2 integrated flow creates an online order, hashes session token and finalizes paid", async () => {
  const fake = createIntegratedSupabase();
  const fetch = createFakeFetch({
    status: 200,
    body: { id: "chr_test_integratedpaid", object: "charge" },
  });
  const orderResponse = await createOnlineOrder(fake, "order-success");
  const orderBody = await orderResponse.json();
  const token = String(orderBody.payment_session.token);
  const expectedHash = await sha256Hex(token);

  const paymentResponse = await createPaymentAttempt(
    fake,
    fetch,
    orderBody.order.id,
    token,
    "attempt-success",
  );
  const paymentBody = await paymentResponse.json();

  assertEquals(orderResponse.status, 201);
  assertMatch(token, /^[A-Za-z0-9_-]{43}$/);
  assertEquals(paymentResponse.status, 201);
  assertEquals(paymentBody.payment_attempt.status, "paid");
  assertEquals(paymentBody.payment_attempt.order_status, "paid");
  assertEquals(fetch.calls.length, 1);
  assertEquals(
    fake.calls.find((call) =>
      call.name === "create_kafka_online_order_with_payment_session"
    )?.args.p_payment_session_token_hash,
    expectedHash,
  );
  assertEquals(
    fake.calls.find((call) =>
      call.name === "validate_order_payment_session_and_reserve_attempt"
    )?.args.p_token_hash,
    expectedHash,
  );
  assertNoSensitiveValues(paymentBody);
});

Deno.test("3C.2 integrated flow finalizes definitive Culqi rejection", async () => {
  const fake = createIntegratedSupabase();
  const fetch = createFakeFetch({
    status: 402,
    body: {
      code: "card_declined",
      decline_code: "insufficient_funds",
      merchant_message: "Card declined",
      type: "card_error",
    },
  });
  const orderBody = await (await createOnlineOrder(fake, "order-rejected"))
    .json();

  const response = await createPaymentAttempt(
    fake,
    fetch,
    orderBody.order.id,
    orderBody.payment_session.token,
    "attempt-rejected",
  );
  const body = await response.json();

  assertEquals(response.status, 402);
  assertEquals(body.payment_attempt.status, "failed");
  assertEquals(body.payment_attempt.order_status, "payment_failed");
  assertEquals(body.payment_attempt.failure_code, "insufficient_funds");
});

Deno.test("3C.2 integrated flow rejects invalid and expired sessions before Culqi", async () => {
  const invalidFake = createIntegratedSupabase();
  const invalidFetch = createFakeFetch({ status: 200 });
  const invalidOrder =
    await (await createOnlineOrder(invalidFake, "order-invalid-session"))
      .json();

  const invalidResponse = await createPaymentAttempt(
    invalidFake,
    invalidFetch,
    invalidOrder.order.id,
    "wrong-payment-session-token",
    "attempt-invalid-session",
  );

  assertEquals(invalidResponse.status, 401);
  assertEquals(invalidFetch.calls.length, 0);

  const expiredFake = createIntegratedSupabase();
  const expiredFetch = createFakeFetch({ status: 200 });
  const expiredOrder =
    await (await createOnlineOrder(expiredFake, "order-expired-session"))
      .json();
  expiredFake.expireSessions();

  const expiredResponse = await createPaymentAttempt(
    expiredFake,
    expiredFetch,
    expiredOrder.order.id,
    expiredOrder.payment_session.token,
    "attempt-expired-session",
  );

  assertEquals(expiredResponse.status, 401);
  assertEquals(expiredFetch.calls.length, 0);
});

Deno.test("3C.2 integrated flow keeps timeout and 3DS responses in processing", async () => {
  const timeoutFake = createIntegratedSupabase();
  const timeoutFetch = createFakeFetch({ rejectsWithAbort: true });
  const timeoutOrder =
    await (await createOnlineOrder(timeoutFake, "order-timeout"))
      .json();

  const timeoutResponse = await createPaymentAttempt(
    timeoutFake,
    timeoutFetch,
    timeoutOrder.order.id,
    timeoutOrder.payment_session.token,
    "attempt-timeout",
  );
  const timeoutBody = await timeoutResponse.json();

  assertEquals(timeoutResponse.status, 202);
  assertEquals(timeoutBody.payment_attempt.status, "processing");
  assertEquals(timeoutBody.payment_result.requires_reconciliation, true);

  const threeDsFake = createIntegratedSupabase();
  const threeDsFetch = createFakeFetch({
    status: 201,
    body: { object: "charge" },
  });
  const threeDsOrder = await (await createOnlineOrder(threeDsFake, "order-3ds"))
    .json();

  const threeDsResponse = await createPaymentAttempt(
    threeDsFake,
    threeDsFetch,
    threeDsOrder.order.id,
    threeDsOrder.payment_session.token,
    "attempt-3ds",
  );
  const threeDsBody = await threeDsResponse.json();

  assertEquals(threeDsResponse.status, 202);
  assertEquals(threeDsBody.payment_attempt.status, "processing");
  assertEquals(threeDsBody.payment_attempt.requires_3ds, true);
  assertEquals(threeDsBody.payment_attempt.three_ds_status, "required");
  assertEquals(threeDsBody.payment_result.reason, "culqi_requires_3ds");
});

Deno.test("3C.2 integrated flow does not create a second charge for duplicate processing attempts", async () => {
  const fake = createIntegratedSupabase();
  const fetch = createFakeFetch({ status: 201, body: { object: "charge" } });
  const orderBody = await (await createOnlineOrder(fake, "order-idempotent"))
    .json();

  const firstResponse = await createPaymentAttempt(
    fake,
    fetch,
    orderBody.order.id,
    orderBody.payment_session.token,
    "attempt-idempotent",
  );
  const secondResponse = await createPaymentAttempt(
    fake,
    fetch,
    orderBody.order.id,
    orderBody.payment_session.token,
    "attempt-idempotent",
  );
  const secondBody = await secondResponse.json();

  assertEquals(firstResponse.status, 202);
  assertEquals(secondResponse.status, 202);
  assertEquals(secondBody.payment_result.reason, "existing_attempt");
  assertEquals(fetch.calls.length, 1);
});

Deno.test("3C.2 integrated flow keeps WhatsApp checkout independent from payment sessions", async () => {
  const fake = createIntegratedSupabase();
  const response = await createWhatsappOrder(fake, "order-whatsapp");
  const body = await response.json();

  assertEquals(response.status, 201);
  assertEquals("payment_session" in body, false);
  assertEquals(fake.sessions.size, 0);
  assertEquals(
    fake.calls.map((call) => call.name),
    ["create_kafka_order"],
  );
});

async function createOnlineOrder(
  fake: ReturnType<typeof createIntegratedSupabase>,
  idempotencyKey: string,
) {
  return await createOrderHandler({
    createSupabaseClient: () => fake,
    env: (name) => name === "CREATE_ORDER_ALLOWED_ORIGINS" ? ORIGIN : undefined,
    now: () => NOW,
  })(
    new Request("http://localhost/functions/v1/create-order", {
      body: JSON.stringify(createOrderPayload(idempotencyKey, "online")),
      headers: {
        "Content-Type": "application/json",
        Origin: ORIGIN,
      },
      method: "POST",
    }),
  );
}

async function createWhatsappOrder(
  fake: ReturnType<typeof createIntegratedSupabase>,
  idempotencyKey: string,
) {
  return await createOrderHandler({
    createSupabaseClient: () => fake,
    env: (name) => name === "CREATE_ORDER_ALLOWED_ORIGINS" ? ORIGIN : undefined,
    now: () => NOW,
  })(
    new Request("http://localhost/functions/v1/create-order", {
      body: JSON.stringify(createOrderPayload(idempotencyKey, "whatsapp")),
      headers: {
        "Content-Type": "application/json",
        Origin: ORIGIN,
      },
      method: "POST",
    }),
  );
}

async function createPaymentAttempt(
  fake: ReturnType<typeof createIntegratedSupabase>,
  fetch: ReturnType<typeof createFakeFetch>,
  orderId: string,
  paymentSessionToken: string,
  idempotencyKey: string,
) {
  return await createPaymentAttemptHandler({
    createSupabaseClient: () => fake,
    env: (name) => {
      const values: Record<string, string> = {
        CREATE_PAYMENT_ATTEMPT_ALLOWED_ORIGINS: ORIGIN,
        CREATE_PAYMENT_ATTEMPT_MOCK_ENABLED: "false",
        CREATE_PAYMENT_ATTEMPT_MODE: "culqi_test",
      };
      return values[name];
    },
    fetch,
  })(
    new Request("http://localhost/functions/v1/create-payment-attempt", {
      body: JSON.stringify({
        store_id: STORE_ID,
        order_id: orderId,
        idempotency_key: idempotencyKey,
        source_id: "tkn_test_integratedsource",
        payment_session_token: paymentSessionToken,
        device_finger_print_id: DEVICE_FINGER_PRINT_ID,
      }),
      headers: {
        "Content-Type": "application/json",
        Origin: ORIGIN,
      },
      method: "POST",
    }),
  );
}

function createOrderPayload(
  idempotencyKey: string,
  checkoutMode: "online" | "whatsapp",
) {
  return {
    store_id: STORE_ID,
    items: [{ product_id: 1, quantity: 2 }],
    customer: {
      name: "Kafka Buyer",
      phone: "+51999999999",
      email: "buyer@example.com",
    },
    idempotency_key: idempotencyKey,
    whatsapp_message: "Kafka checkout message",
    checkout_mode: checkoutMode,
  };
}

function createIntegratedSupabase() {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const orders = new Map<string, Record<string, unknown>>();
  const orderIdsByIdempotencyKey = new Map<string, string>();
  const sessions = new Map<string, Record<string, unknown>>();
  const attempts = new Map<string, Record<string, unknown>>();
  let orderCount = 0;
  let attemptCount = 0;

  function orderResponse(order: Record<string, unknown>) {
    return {
      id: order.id,
      store_id: order.store_id,
      status: order.status,
      currency: order.currency,
      total_amount_cents: order.total_amount_cents,
    };
  }

  function attemptResponse(
    order: Record<string, unknown>,
    attempt: Record<string, unknown>,
  ) {
    return {
      id: attempt.id,
      order_id: order.id,
      store_id: order.store_id,
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
      requires_3ds: attempt.requires_3ds ?? false,
      three_ds_status: attempt.three_ds_status ?? null,
      reconciliation_required: attempt.reconciliation_required ?? false,
      created_at: "2026-10-13T12:00:00.000Z",
      updated_at: "2026-10-13T12:00:00.000Z",
    };
  }

  function reserveAttempt(args: Record<string, unknown>) {
    const order = orders.get(String(args.p_order_id));
    if (!order) {
      return {
        data: null,
        error: { message: "orden invalida" },
        existing: false,
      };
    }

    const existing = attempts.get(String(args.p_idempotency_key));
    if (existing) {
      if (existing.source_id !== args.p_culqi_source_id) {
        return {
          data: null,
          error: { message: "payment idempotency key conflict" },
          existing: true,
        };
      }

      return {
        data: attemptResponse(order, existing),
        error: null,
        existing: true,
      };
    }

    const active = Array.from(attempts.values()).find((attempt) =>
      attempt.order_id === order.id &&
      (attempt.status === "created" || attempt.status === "processing")
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
      id: `22222222-2222-4222-8222-${String(attemptCount).padStart(12, "0")}`,
      idempotency_key: args.p_idempotency_key,
      order_id: order.id,
      source_id: args.p_culqi_source_id,
      status: "created",
    };
    attempts.set(String(args.p_idempotency_key), attempt);

    return {
      data: attemptResponse(order, attempt),
      error: null,
      existing: false,
    };
  }

  return {
    calls,
    sessions,
    expireSessions() {
      for (const session of sessions.values()) {
        session.status = "expired";
      }
    },
    from(table: string) {
      return createFakeQuery(table, orders, attempts);
    },
    async rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });

      if (name === "create_kafka_online_order_with_payment_session") {
        const existingOrderId = orderIdsByIdempotencyKey.get(
          String(args.p_idempotency_key),
        );
        if (existingOrderId) {
          return {
            data: {
              order: orderResponse(orders.get(existingOrderId)!),
              payment_session_created: false,
            },
            error: null,
          };
        }

        orderCount += 1;
        const order = {
          id: `11111111-1111-4111-8111-${String(orderCount).padStart(12, "0")}`,
          store_id: args.p_store_id,
          customer_email: args.p_customer_email,
          whatsapp_message: args.p_whatsapp_message,
          status: "pending_payment",
          currency: "PEN",
          total_amount_cents: 2000,
        };
        orders.set(String(order.id), order);
        orderIdsByIdempotencyKey.set(
          String(args.p_idempotency_key),
          String(order.id),
        );
        sessions.set(String(args.p_payment_session_token_hash), {
          order_id: order.id,
          store_id: order.store_id,
          token_hash: args.p_payment_session_token_hash,
          status: "active",
          expires_at: args.p_payment_session_expires_at,
        });

        return {
          data: {
            order: orderResponse(order),
            payment_session_created: true,
            payment_session: { expires_at: args.p_payment_session_expires_at },
          },
          error: null,
        };
      }

      if (name === "create_kafka_order") {
        orderCount += 1;
        const order = {
          id: `11111111-1111-4111-8111-${String(orderCount).padStart(12, "0")}`,
          store_id: args.p_store_id,
          customer_email: args.p_customer_email,
          whatsapp_message: args.p_whatsapp_message,
          status: "pending_payment",
          currency: "PEN",
          total_amount_cents: 2000,
        };
        orders.set(String(order.id), order);
        return { data: orderResponse(order), error: null };
      }

      if (name === "validate_order_payment_session_and_reserve_attempt") {
        const order = orders.get(String(args.p_order_id));
        const session = sessions.get(String(args.p_token_hash));
        if (
          !order ||
          !session ||
          session.order_id !== order.id ||
          session.store_id !== args.p_store_id
        ) {
          return { data: { valid: false, reason: "invalid" }, error: null };
        }

        if (session.status !== "active") {
          return {
            data: { valid: false, reason: session.status },
            error: null,
          };
        }

        const reserved = reserveAttempt(args);
        if (reserved.error) {
          return { data: null, error: reserved.error };
        }

        return {
          data: {
            valid: true,
            existing_attempt: reserved.existing,
            payment_attempt: reserved.data,
            order,
            session: {
              store_id: session.store_id,
              order_id: session.order_id,
              expires_at: session.expires_at,
            },
          },
          error: null,
        };
      }

      if (name === "get_culqi_test_private_key_for_payment") {
        return { data: "sk_test_integratedprivatekey", error: null };
      }

      if (name === "claim_kafka_payment_attempt_processing") {
        const attempt = Array.from(attempts.values()).find((item) =>
          item.id === args.p_payment_attempt_id
        );
        const order = attempt ? orders.get(String(attempt.order_id)) : null;

        if (!attempt || !order) {
          return { data: null, error: { message: "intento de pago invalido" } };
        }

        if (attempt.status === "processing") {
          return {
            data: {
              acquired: false,
              reason: "already_processing",
              payment_attempt: attemptResponse(order, attempt),
            },
            error: null,
          };
        }

        if (attempt.status !== "created") {
          return {
            data: {
              acquired: false,
              reason: "terminal_state",
              payment_attempt: attemptResponse(order, attempt),
            },
            error: null,
          };
        }

        attempt.status = "processing";
        return {
          data: {
            acquired: true,
            reason: "claimed",
            payment_attempt: attemptResponse(order, attempt),
          },
          error: null,
        };
      }

      if (name === "record_kafka_payment_attempt_uncertainty") {
        const attempt = Array.from(attempts.values()).find((item) =>
          item.id === args.p_payment_attempt_id
        );
        const order = attempt ? orders.get(String(attempt.order_id)) : null;
        if (!attempt || !order) {
          return { data: null, error: { message: "invalid uncertainty" } };
        }
        attempt.reconciliation_required = true;
        attempt.reconciliation_reason = args.p_reason;
        return { data: attemptResponse(order, attempt), error: null };
      }

      if (name === "finalize_kafka_payment_attempt") {
        const attempt = Array.from(attempts.values()).find((item) =>
          item.id === args.p_payment_attempt_id
        );
        const order = attempt ? orders.get(String(attempt.order_id)) : null;

        if (!attempt || !order || attempt.status !== "processing") {
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

        return { data: attemptResponse(order, attempt), error: null };
      }

      if (name === "mark_kafka_payment_attempt_requires_3ds") {
        const attempt = Array.from(attempts.values()).find((item) =>
          item.id === args.p_payment_attempt_id
        );
        const order = attempt ? orders.get(String(attempt.order_id)) : null;

        if (!attempt || !order || attempt.status !== "processing") {
          return {
            data: null,
            error: { message: "intento de pago inconsistente con la orden" },
          };
        }

        attempt.requires_3ds = true;
        attempt.three_ds_status = "required";
        attempt.provider_reference = args.p_provider_reference;
        attempt.reconciliation_required = false;

        return { data: attemptResponse(order, attempt), error: null };
      }

      return { data: null, error: { message: `RPC inesperado: ${name}` } };
    },
  };
}

function createFakeQuery(
  table: string,
  orders: Map<string, Record<string, unknown>>,
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
        const order = orders.get(String(filters.id));
        return {
          data: order && order.store_id === filters.store_id ? order : null,
          error: null,
        };
      }

      if (table === "payment_attempts") {
        const attempt = attempts.get(String(filters.idempotency_key));
        return {
          data: attempt ? { id: attempt.id } : null,
          error: null,
        };
      }

      return { data: null, error: { message: `Tabla inesperada: ${table}` } };
    },
  };
}

function createFakeFetch({
  body = { id: "chr_test_integratedsuccess", object: "charge" },
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
}
