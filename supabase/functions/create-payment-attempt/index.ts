import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.3";
import { validateCulqiTestEvidence } from "../_shared/culqi-test-evidence.ts";

type CreatePaymentAttemptPayload = {
  store_id?: unknown;
  order_id?: unknown;
  idempotency_key?: unknown;
  source_id?: unknown;
  payment_session_token?: unknown;
  device_finger_print_id?: unknown;
};

type ValidatedPayload = {
  storeId: number;
  orderId: string;
  idempotencyKey: string;
  sourceId: string;
  paymentSessionToken: string | null;
  deviceFingerPrintId: string | null;
};

type PaymentMode = "mock" | "culqi_test";
type MockResult = "success" | "failed" | "uncertain";

type MockConfig = {
  allowedStoreId: number;
  result: MockResult;
  testRunnerSecret: string;
};

type PaymentAttemptResponse = {
  id: string;
  order_id: string;
  store_id: number;
  provider: string;
  environment: string;
  status: string;
  order_status: string;
  amount_cents: number;
  currency: string;
  culqi_charge_id: string | null;
  failure_code: string | null;
  failure_message: string | null;
  provider_reference: string | null;
  requires_3ds?: boolean;
  three_ds_status?: string | null;
  reconciliation_required?: boolean;
  created_at: string;
  updated_at: string;
};

type ClaimPaymentAttemptResponse = {
  acquired: boolean;
  reason: string;
  payment_attempt: PaymentAttemptResponse;
};

type TestOrderRecord = {
  id: string;
  store_id: number;
  customer_email: string | null;
  whatsapp_message: string | null;
  status: string;
  total_amount_cents: number;
  currency: string;
};

type PaymentSessionReserveResponse = {
  valid: boolean;
  reason?: string;
  existing_attempt?: boolean;
  payment_attempt?: PaymentAttemptResponse;
  order?: TestOrderRecord;
  session?: {
    store_id?: number;
    order_id?: string;
    expires_at?: string;
  };
};

type SupabaseResult<T> = {
  data: T | null;
  error: { message: string } | null;
};

type SupabaseLike = {
  from: (table: string) => unknown;
  rpc: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<SupabaseResult<unknown>>;
};

type HandlerDependencies = {
  createSupabaseClient: () => SupabaseLike | null;
  env: (name: string) => string | undefined;
  fetch: typeof fetch;
};

const MAX_BODY_BYTES = 2048;
const MAX_IDEMPOTENCY_LENGTH = 120;
const MAX_SOURCE_ID_LENGTH = 120;
const MAX_PAYMENT_SESSION_TOKEN_LENGTH = 256;
const MAX_DEVICE_FINGER_PRINT_LENGTH = 64;
const MIN_TEST_RUNNER_SECRET_LENGTH = 32;
const DEFAULT_CULQI_CHARGES_URL = "https://api.culqi.com/v2/charges";
const DEFAULT_CULQI_TIMEOUT_MS = 8000;
const DEFINITIVE_CULQI_DECLINE_CODES = new Set([
  "expired_card",
  "stolen_card",
  "lost_card",
  "insufficient_funds",
  "contact_issuer",
  "invalid_cvv",
  "incorrect_cvv",
  "too_many_attempts_cvv",
  "issuer_decline_operation",
  "invalid_card",
  "fraudulent",
  "culqi_card",
]);
const TEST_ORDER_EMAIL = "payments-integration-test@example.com";
const TEST_ORDER_MARKER = "Kafka Payments 3B integration test -";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEVICE_FINGER_PRINT_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TEST_SOURCE_PATTERN = /^(tkn|ype|crd)_test_[A-Za-z0-9]+$/;
const FORBIDDEN_CLIENT_FIELDS = new Set([
  "amount",
  "amount_cents",
  "currency",
  "currency_code",
  "mock_result",
  "payment_result",
  "status",
  "final_status",
  "price",
  "total",
]);

export function createHandler(dependencies: HandlerDependencies) {
  return async (request: Request) => {
    const origin = request.headers.get("origin");
    const allowedOrigins = parseAllowedOrigins(
      dependencies.env("CREATE_PAYMENT_ATTEMPT_ALLOWED_ORIGINS") ??
        dependencies.env("CREATE_ORDER_ALLOWED_ORIGINS") ??
        "",
    );
    const corsHeaders = getCorsHeaders(origin, allowedOrigins);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: corsHeaders ?? undefined,
        status: corsHeaders ? 204 : 403,
      });
    }

    if (!corsHeaders) {
      return jsonResponse({ error: "Origin no permitido." }, 403);
    }

    if (request.method !== "POST") {
      return jsonResponse(
        { error: "Metodo no permitido." },
        405,
        corsHeaders,
        { Allow: "POST, OPTIONS" },
      );
    }

    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("application/json")) {
      return jsonResponse(
        { error: "El contenido debe ser application/json." },
        415,
        corsHeaders,
      );
    }

    try {
      const mode = readPaymentMode(dependencies.env);
      const rawBody = await readLimitedBody(request, MAX_BODY_BYTES);
      const payload = validatePayload(
        JSON.parse(rawBody) as CreatePaymentAttemptPayload,
      );

      const supabase = dependencies.createSupabaseClient();
      if (!supabase) {
        return jsonResponse(
          { error: "Configuracion de servidor incompleta." },
          500,
          corsHeaders,
        );
      }

      if (mode === "mock") {
        const mockConfig = readMockConfig(dependencies.env);
        const providedSecret =
          request.headers.get("x-kafka-mock-test-secret") ?? "";

        if (
          !(await timingSafeSecretEquals(
            providedSecret,
            mockConfig.testRunnerSecret,
          ))
        ) {
          return jsonResponse({ error: "No autorizado." }, 401, corsHeaders);
        }

        if (payload.storeId !== mockConfig.allowedStoreId) {
          return jsonResponse(
            { error: "Tienda no habilitada para pagos MOCK." },
            403,
            corsHeaders,
          );
        }

        const testOrder = await getAuthorizedTestOrder(supabase, payload);
        if (!testOrder.authorized) {
          return jsonResponse(
            { error: testOrder.error },
            testOrder.status,
            corsHeaders,
          );
        }

        return await processMockPaymentAttempt(
          supabase,
          payload,
          mockConfig,
          corsHeaders,
        );
      }

      return await processCulqiTestPaymentAttempt(
        supabase,
        payload,
        dependencies,
        corsHeaders,
      );
    } catch (error) {
      return jsonResponse(
        {
          error: error instanceof Error
            ? sanitizeErrorMessage(error.message)
            : "Solicitud invalida.",
        },
        400,
        corsHeaders,
      );
    }
  };
}

async function processMockPaymentAttempt(
  supabase: SupabaseLike,
  payload: ValidatedPayload,
  mockConfig: MockConfig,
  corsHeaders: Record<string, string>,
) {
  const existingAttempt = await findExistingAttemptId(
    supabase,
    payload.storeId,
    payload.idempotencyKey,
  );

  const reservedAttemptResult = await supabase.rpc(
    "reserve_kafka_payment_attempt",
    {
      p_store_id: payload.storeId,
      p_order_id: payload.orderId,
      p_idempotency_key: payload.idempotencyKey,
      p_culqi_source_id: payload.sourceId,
    },
  );

  if (reservedAttemptResult.error) {
    return jsonResponse(
      { error: getSafeDatabaseError(reservedAttemptResult.error.message) },
      getStatusForDatabaseError(reservedAttemptResult.error.message),
      corsHeaders,
    );
  }

  const reservedAttempt = reservedAttemptResult.data as PaymentAttemptResponse;

  if (existingAttempt) {
    return paymentAttemptJsonResponse(
      reservedAttempt,
      {
        mode: "mock",
        processed: false,
        reason: "existing_attempt",
        result: null,
      },
      200,
      corsHeaders,
    );
  }

  if (reservedAttempt.status !== "created") {
    return paymentAttemptJsonResponse(
      reservedAttempt,
      {
        mode: "mock",
        processed: false,
        reason: "attempt_not_created",
        result: null,
      },
      200,
      corsHeaders,
    );
  }

  const claimResult = await supabase.rpc(
    "claim_kafka_payment_attempt_processing",
    {
      p_store_id: payload.storeId,
      p_payment_attempt_id: reservedAttempt.id,
    },
  );

  if (claimResult.error) {
    return jsonResponse(
      { error: getSafeDatabaseError(claimResult.error.message) },
      getStatusForDatabaseError(claimResult.error.message),
      corsHeaders,
    );
  }

  const claim = claimResult.data as ClaimPaymentAttemptResponse;
  const processingAttempt = claim.payment_attempt;

  if (!claim.acquired) {
    return paymentAttemptJsonResponse(
      processingAttempt,
      {
        mode: "mock",
        processed: false,
        reason: claim.reason,
        result: null,
      },
      claim.reason === "already_processing" ? 202 : 200,
      corsHeaders,
    );
  }

  if (mockConfig.result === "uncertain") {
    return await persistUncertaintyResponse(
      supabase,
      payload.storeId,
      processingAttempt,
      "mock_uncertain_response",
      {
        mode: "mock",
        processed: true,
        reason: "mock_uncertain_response",
        result: "uncertain",
        requires_reconciliation: true,
      },
      corsHeaders,
    );
  }

  const finalStatus = mockConfig.result === "success" ? "paid" : "failed";
  const mockChargeId = buildMockChargeId(processingAttempt.id);
  const finalizeResult = await supabase.rpc("finalize_kafka_payment_attempt", {
    p_store_id: payload.storeId,
    p_payment_attempt_id: processingAttempt.id,
    p_final_status: finalStatus,
    p_culqi_charge_id: mockConfig.result === "success" ? mockChargeId : null,
    p_failure_code: mockConfig.result === "failed"
      ? "mock_definitive_rejection"
      : null,
    p_failure_message: mockConfig.result === "failed"
      ? "Pago rechazado por simulacion MOCK."
      : null,
    p_provider_event_id: buildMockProviderEventId(
      processingAttempt.id,
      mockConfig.result,
    ),
    p_provider_reference: mockConfig.result === "success" ? mockChargeId : null,
    p_sanitized_payload: {
      mode: "mock",
      result: mockConfig.result,
      simulated: true,
      marker: "Kafka Payments 3B MOCK",
    },
  });

  if (finalizeResult.error) {
    return jsonResponse(
      { error: getSafeDatabaseError(finalizeResult.error.message) },
      getStatusForDatabaseError(finalizeResult.error.message),
      corsHeaders,
    );
  }

  return paymentAttemptJsonResponse(
    finalizeResult.data as PaymentAttemptResponse,
    {
      mode: "mock",
      processed: true,
      reason:
        (finalizeResult.data as PaymentAttemptResponse).status === finalStatus
          ? "mock_finalized"
          : "already_finalized",
      result: (finalizeResult.data as PaymentAttemptResponse).status === "paid"
        ? "success"
        : (finalizeResult.data as PaymentAttemptResponse).status === "failed"
        ? "failed"
        : null,
    },
    (finalizeResult.data as PaymentAttemptResponse).status !== finalStatus
      ? 200
      : mockConfig.result === "success"
      ? 201
      : 402,
    corsHeaders,
  );
}

async function processCulqiTestPaymentAttempt(
  supabase: SupabaseLike,
  payload: ValidatedPayload,
  dependencies: HandlerDependencies,
  corsHeaders: Record<string, string>,
) {
  if (!payload.paymentSessionToken) {
    return jsonResponse(
      { error: "Sesion de pago requerida." },
      401,
      corsHeaders,
    );
  }

  if (!payload.deviceFingerPrintId) {
    return jsonResponse(
      { error: "device_finger_print_id requerido para pago con tarjeta." },
      400,
      corsHeaders,
    );
  }

  const culqiChargesUrl = readCulqiChargesUrl(dependencies.env);
  const culqiTimeoutMs = readTimeoutMs(dependencies.env);
  const paymentSessionTokenHash = await sha256Hex(payload.paymentSessionToken);
  const sessionReserveResult = await supabase.rpc(
    "validate_order_payment_session_and_reserve_attempt",
    {
      p_store_id: payload.storeId,
      p_order_id: payload.orderId,
      p_token_hash: paymentSessionTokenHash,
      p_idempotency_key: payload.idempotencyKey,
      p_culqi_source_id: payload.sourceId,
    },
  );

  if (sessionReserveResult.error) {
    return jsonResponse(
      { error: getSafeDatabaseError(sessionReserveResult.error.message) },
      getStatusForDatabaseError(sessionReserveResult.error.message),
      corsHeaders,
    );
  }

  const sessionReserve = sessionReserveResult
    .data as PaymentSessionReserveResponse;
  if (sessionReserve.valid !== true) {
    return jsonResponse(
      { error: "Sesion de pago invalida." },
      401,
      corsHeaders,
    );
  }

  if (!sessionReserve.payment_attempt) {
    return jsonResponse(
      { error: "No se pudo reservar el intento de pago." },
      500,
      corsHeaders,
    );
  }

  const order = sessionReserve.order;
  if (!order?.customer_email) {
    return jsonResponse(
      { error: "Email del comprador requerido para pago con tarjeta." },
      400,
      corsHeaders,
    );
  }

  const reservedAttempt = sessionReserve.payment_attempt;

  if (sessionReserve.existing_attempt && reservedAttempt.status !== "created") {
    return paymentAttemptJsonResponse(
      reservedAttempt,
      {
        mode: "culqi_test",
        processed: false,
        reason: "existing_attempt",
      },
      reservedAttempt.status === "processing" ? 202 : 200,
      corsHeaders,
    );
  }

  // A replay may recover a reservation that never acquired the processing claim.
  if (reservedAttempt.status !== "created") {
    return paymentAttemptJsonResponse(
      reservedAttempt,
      {
        mode: "culqi_test",
        processed: false,
        reason: "attempt_not_created",
      },
      reservedAttempt.status === "processing" ? 202 : 200,
      corsHeaders,
    );
  }

  const privateKeyResult = await supabase.rpc(
    "get_culqi_test_private_key_for_payment",
    { p_store_id: payload.storeId },
  );

  if (privateKeyResult.error || typeof privateKeyResult.data !== "string") {
    return jsonResponse(
      { error: "Configuracion de pagos invalida." },
      500,
      corsHeaders,
    );
  }

  if (!/^sk_test_[A-Za-z0-9]+$/.test(privateKeyResult.data)) {
    return jsonResponse(
      { error: "Configuracion de pagos invalida." },
      500,
      corsHeaders,
    );
  }

  const claimResult = await supabase.rpc(
    "claim_kafka_payment_attempt_processing",
    {
      p_store_id: payload.storeId,
      p_payment_attempt_id: reservedAttempt.id,
    },
  );

  if (claimResult.error) {
    return jsonResponse(
      { error: getSafeDatabaseError(claimResult.error.message) },
      getStatusForDatabaseError(claimResult.error.message),
      corsHeaders,
    );
  }

  const claim = claimResult.data as ClaimPaymentAttemptResponse;
  const processingAttempt = claim.payment_attempt;

  if (claim.acquired !== true) {
    return paymentAttemptJsonResponse(
      processingAttempt,
      {
        mode: "culqi_test",
        processed: false,
        reason: claim.reason,
      },
      claim.reason === "already_processing" ? 202 : 200,
      corsHeaders,
    );
  }

  const culqiResponse = await createCulqiCharge({
    amountCents: processingAttempt.amount_cents,
    chargesUrl: culqiChargesUrl,
    currency: processingAttempt.currency,
    email: order.customer_email,
    fetchImpl: dependencies.fetch,
    orderId: payload.orderId,
    privateKey: privateKeyResult.data,
    sourceId: payload.sourceId,
    storeId: payload.storeId,
    timeoutMs: culqiTimeoutMs,
    paymentAttemptId: processingAttempt.id,
    deviceFingerPrintId: payload.deviceFingerPrintId,
  });

  if (culqiResponse.kind === "definitive_failure") {
    const finalizeResult = await supabase.rpc(
      "finalize_kafka_payment_attempt",
      {
        p_store_id: payload.storeId,
        p_payment_attempt_id: processingAttempt.id,
        p_final_status: "failed",
        p_culqi_charge_id: null,
        p_failure_code: culqiResponse.failureCode,
        p_failure_message: culqiResponse.failureMessage,
        p_provider_event_id: null,
        p_provider_reference: null,
        p_sanitized_payload: culqiResponse.sanitizedPayload,
      },
    );

    if (finalizeResult.error) {
      return await persistUncertaintyResponse(
        supabase,
        payload.storeId,
        processingAttempt,
        "culqi_finalize_failed",
        {
          mode: "culqi_test",
          processed: true,
          reason: "culqi_finalize_failed",
          requires_reconciliation: true,
        },
        corsHeaders,
      );
    }

    return paymentAttemptJsonResponse(
      finalizeResult.data as PaymentAttemptResponse,
      {
        mode: "culqi_test",
        processed: true,
        reason:
          (finalizeResult.data as PaymentAttemptResponse).status !== "failed"
            ? "already_finalized"
            : "culqi_definitive_failure",
      },
      (finalizeResult.data as PaymentAttemptResponse).status !== "failed"
        ? 200
        : 402,
      corsHeaders,
    );
  }

  if (culqiResponse.kind === "requires_3ds") {
    const mark3dsResult = await supabase.rpc(
      "mark_kafka_payment_attempt_requires_3ds",
      {
        p_store_id: payload.storeId,
        p_payment_attempt_id: processingAttempt.id,
        p_device_fingerprint_id: payload.deviceFingerPrintId,
        p_provider_reference: culqiResponse.providerReference,
        p_sanitized_payload: culqiResponse.sanitizedPayload,
      },
    );

    if (mark3dsResult.error) {
      return await persistUncertaintyResponse(
        supabase,
        payload.storeId,
        processingAttempt,
        "culqi_metadata_failed",
        {
          mode: "culqi_test",
          processed: true,
          reason: "culqi_metadata_failed",
          requires_reconciliation: true,
        },
        corsHeaders,
        /^chr_test_[A-Za-z0-9]+$/.test(culqiResponse.providerReference ?? "")
          ? culqiResponse.providerReference
          : null,
      );
    }

    return paymentAttemptJsonResponse(
      mark3dsResult.data as PaymentAttemptResponse,
      {
        mode: "culqi_test",
        processed: true,
        reason: "culqi_requires_3ds",
        requires_3ds: true,
      },
      202,
      corsHeaders,
    );
  }

  return await persistUncertaintyResponse(
    supabase,
    payload.storeId,
    processingAttempt,
    culqiResponse.reason,
    {
      mode: "culqi_test",
      processed: true,
      reason: culqiResponse.reason,
      requires_reconciliation: true,
    },
    corsHeaders,
    culqiResponse.providerReference ?? null,
  );
}

async function persistUncertaintyResponse(
  supabase: SupabaseLike,
  storeId: number,
  attempt: PaymentAttemptResponse,
  reason: string,
  paymentResult: Record<string, unknown>,
  corsHeaders: Record<string, string>,
  providerReference: string | null = null,
) {
  const result = await supabase.rpc(
    "record_kafka_payment_attempt_uncertainty",
    {
      p_store_id: storeId,
      p_payment_attempt_id: attempt.id,
      p_reason: reason,
      // Never overwrite an existing, different reference with an unverified candidate.
      p_provider_reference: attempt.provider_reference &&
          attempt.provider_reference !== providerReference
        ? null
        : providerReference,
    },
  );
  if (result.error || !result.data) {
    return jsonResponse(
      {
        error:
          "No se pudo registrar el resultado incierto. No repita el cargo.",
        requires_reconciliation: true,
      },
      503,
      corsHeaders,
    );
  }
  const persisted = result.data as PaymentAttemptResponse;
  const terminal = persisted.status === "paid" || persisted.status === "failed";
  return paymentAttemptJsonResponse(
    persisted,
    {
      ...paymentResult,
      reason: terminal ? "already_finalized" : reason,
      requires_reconciliation: persisted.reconciliation_required === true,
    },
    terminal ? 200 : 202,
    corsHeaders,
  );
}

const defaultDependencies: HandlerDependencies = {
  createSupabaseClient: () => {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !serviceRoleKey) {
      return null;
    }

    return createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
      global: {
        headers: {
          "X-Client-Info": "kafka-payments-create-payment-attempt",
        },
      },
    }) as unknown as SupabaseLike;
  },
  env: (name: string) => Deno.env.get(name) ?? undefined,
  fetch: fetch.bind(globalThis),
};

export const handler = createHandler(defaultDependencies);

if (import.meta.main) {
  serve(handler);
}

function validatePayload(
  payload: CreatePaymentAttemptPayload,
): ValidatedPayload {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Payload invalido.");
  }

  for (const field of Object.keys(payload)) {
    if (
      ![
        "store_id",
        "order_id",
        "idempotency_key",
        "source_id",
        "payment_session_token",
        "device_finger_print_id",
      ].includes(field)
    ) {
      throw new Error(`${field} no esta permitido.`);
    }

    if (FORBIDDEN_CLIENT_FIELDS.has(field)) {
      throw new Error(`${field} no esta permitido.`);
    }
  }

  const storeId = parsePositiveInteger(payload.store_id, "store_id");
  const orderId = parseUuid(payload.order_id, "order_id");
  const idempotencyKey = parseRequiredString(
    payload.idempotency_key,
    "idempotency_key",
    MAX_IDEMPOTENCY_LENGTH,
  );
  const sourceId = parseRequiredString(
    payload.source_id,
    "source_id",
    MAX_SOURCE_ID_LENGTH,
  );
  const paymentSessionToken = parseOptionalString(
    payload.payment_session_token,
    "payment_session_token",
    MAX_PAYMENT_SESSION_TOKEN_LENGTH,
  );
  const deviceFingerPrintId = parseOptionalString(
    payload.device_finger_print_id,
    "device_finger_print_id",
    MAX_DEVICE_FINGER_PRINT_LENGTH,
  );

  if (!TEST_SOURCE_PATTERN.test(sourceId)) {
    throw new Error("source_id Culqi TEST invalido.");
  }

  if (
    deviceFingerPrintId !== null &&
    !DEVICE_FINGER_PRINT_PATTERN.test(deviceFingerPrintId)
  ) {
    throw new Error("device_finger_print_id invalido.");
  }

  return {
    storeId,
    orderId,
    idempotencyKey,
    sourceId,
    paymentSessionToken,
    deviceFingerPrintId,
  };
}

function readMockConfig(env: HandlerDependencies["env"]): MockConfig {
  if (env("CREATE_PAYMENT_ATTEMPT_MOCK_ENABLED") !== "true") {
    throw new Error("create-payment-attempt MOCK no esta habilitado.");
  }

  const allowedStoreId = parsePositiveInteger(
    env("CREATE_PAYMENT_ATTEMPT_MOCK_ALLOWED_STORE_ID"),
    "CREATE_PAYMENT_ATTEMPT_MOCK_ALLOWED_STORE_ID",
  );
  const result = env("CREATE_PAYMENT_ATTEMPT_MOCK_RESULT");
  const testRunnerSecret =
    env("CREATE_PAYMENT_ATTEMPT_MOCK_TEST_RUNNER_SECRET") ?? "";

  if (result !== "success" && result !== "failed" && result !== "uncertain") {
    throw new Error("CREATE_PAYMENT_ATTEMPT_MOCK_RESULT invalido.");
  }

  if (testRunnerSecret.length < MIN_TEST_RUNNER_SECRET_LENGTH) {
    throw new Error("CREATE_PAYMENT_ATTEMPT_MOCK_TEST_RUNNER_SECRET invalido.");
  }

  return { allowedStoreId, result: result as MockResult, testRunnerSecret };
}

function readPaymentMode(env: HandlerDependencies["env"]): PaymentMode {
  const mode = env("CREATE_PAYMENT_ATTEMPT_MODE");

  if (mode === "mock" || mode === "culqi_test") {
    return mode;
  }

  if (!mode && env("CREATE_PAYMENT_ATTEMPT_MOCK_ENABLED") === "true") {
    return "mock";
  }

  throw new Error("CREATE_PAYMENT_ATTEMPT_MODE invalido.");
}

function readTimeoutMs(env: HandlerDependencies["env"]) {
  const rawValue = env("CREATE_PAYMENT_ATTEMPT_CULQI_TIMEOUT_MS");

  if (!rawValue) {
    return DEFAULT_CULQI_TIMEOUT_MS;
  }

  const timeoutMs = Number(rawValue);

  if (
    !Number.isSafeInteger(timeoutMs) || timeoutMs < 2000 || timeoutMs > 15000
  ) {
    throw new Error("CREATE_PAYMENT_ATTEMPT_CULQI_TIMEOUT_MS invalido.");
  }

  return timeoutMs;
}

function readCulqiChargesUrl(env: HandlerDependencies["env"]) {
  const configuredUrl = env("CREATE_PAYMENT_ATTEMPT_CULQI_CHARGES_URL") ??
    DEFAULT_CULQI_CHARGES_URL;

  if (configuredUrl !== DEFAULT_CULQI_CHARGES_URL) {
    throw new Error("CREATE_PAYMENT_ATTEMPT_CULQI_CHARGES_URL invalido.");
  }

  return configuredUrl;
}

type CulqiChargeResult =
  | {
    kind: "definitive_failure";
    failureCode: string;
    failureMessage: string;
    sanitizedPayload: Record<string, unknown>;
  }
  | {
    kind: "requires_3ds";
    providerReference: string | null;
    sanitizedPayload: Record<string, unknown>;
  }
  | {
    kind: "uncertain";
    reason: string;
    providerReference?: string | null;
  };

async function createCulqiCharge({
  amountCents,
  chargesUrl,
  currency,
  email,
  fetchImpl,
  orderId,
  paymentAttemptId,
  privateKey,
  sourceId,
  storeId,
  timeoutMs,
  deviceFingerPrintId,
}: {
  amountCents: number;
  chargesUrl: string;
  currency: string;
  email: string;
  fetchImpl: typeof fetch;
  orderId: string;
  paymentAttemptId: string;
  privateKey: string;
  sourceId: string;
  storeId: number;
  timeoutMs: number;
  deviceFingerPrintId: string;
}): Promise<CulqiChargeResult> {
  if (!/^sk_test_[A-Za-z0-9]+$/.test(privateKey)) {
    throw new Error("Configuracion de pagos invalida.");
  }

  if (
    !Number.isSafeInteger(amountCents) || amountCents <= 0 || currency !== "PEN"
  ) {
    throw new Error("Monto de pago invalido.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(chargesUrl, {
      body: JSON.stringify({
        amount: amountCents,
        currency_code: currency,
        email,
        source_id: sourceId,
        capture: true,
        antifraud_details: {
          device_finger_print_id: deviceFingerPrintId,
        },
        description: `Kafka order ${orderId}`,
        metadata: {
          kafka_order_id: orderId,
          kafka_payment_attempt_id: paymentAttemptId,
          kafka_store_id: String(storeId),
        },
      }),
      headers: {
        Authorization: `Bearer ${privateKey}`,
        "Content-Type": "application/json",
      },
      method: "POST",
      signal: controller.signal,
    });

    const body = await safeReadJson(response);

    if (response.status === 200) {
      const evidence = validateCulqiTestEvidence({
        operation: "create_charge",
        httpStatus: response.status,
        body,
        expected: {
          storeId,
          orderId,
          paymentAttemptId,
          amountCents,
          currency,
          environment: "test",
        },
      });
      const chargeId = typeof body?.id === "string" ? body.id : "";
      if (
        chargeId.trim() !== chargeId ||
        !/^chr_test_[A-Za-z0-9]{1,151}$/.test(chargeId)
      ) {
        return { kind: "uncertain", reason: "culqi_success_without_charge_id" };
      }
      if (!evidence.canFinalizePaid) {
        return {
          kind: "uncertain",
          reason: "culqi_ambiguous_200",
          // Shape-valid ID is only a review candidate, never a confirmed charge.
          providerReference: evidence.identity.status === "contradictory"
            ? null
            : chargeId,
        };
      }
      // No financial-success branch exists until the provider contract is reviewed.
      return { kind: "uncertain", reason: "culqi_ambiguous_200" };
    }

    if (response.status === 201) {
      const evidence = validateCulqiTestEvidence({
        operation: "create_charge",
        httpStatus: response.status,
        body,
        expected: {
          storeId,
          orderId,
          paymentAttemptId,
          amountCents,
          currency,
          environment: "test",
        },
      });
      // 201 signals 3DS, not a guaranteed charge-shaped identity response.
      // Missing fields must not be filled from our request to manufacture evidence.
      if (evidence.identity.status !== "compatible") {
        return { kind: "uncertain", reason: "culqi_ambiguous_201" };
      }
      const providerReference = body!.id as string;
      return {
        kind: "requires_3ds",
        providerReference,
        sanitizedPayload: {
          culqi_status: response.status,
          object: sanitizeCulqiString(body?.object),
          requires_3ds: true,
        },
      };
    }

    if (response.status === 400 || response.status === 402) {
      if (!isDefinitiveCulqiCardDecline(body)) {
        return {
          kind: "uncertain",
          reason: `culqi_ambiguous_${response.status}`,
        };
      }

      const failureCode = sanitizeCulqiString(body?.decline_code ?? body?.code);
      const failureMessage = sanitizeCulqiString(
        body?.merchant_message ?? body?.user_message ??
          "Pago rechazado por Culqi.",
      );

      return {
        kind: "definitive_failure",
        failureCode,
        failureMessage,
        sanitizedPayload: {
          culqi_status: response.status,
          code: failureCode,
          type: sanitizeCulqiString(body?.type),
        },
      };
    }

    return { kind: "uncertain", reason: `culqi_http_${response.status}` };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return { kind: "uncertain", reason: "culqi_timeout" };
    }

    return { kind: "uncertain", reason: "culqi_network_error" };
  } finally {
    clearTimeout(timeout);
  }
}

function isDefinitiveCulqiCardDecline(body: Record<string, unknown> | null) {
  if (!body) {
    return false;
  }

  const type = String(body.type ?? "");
  const code = String(body.code ?? "");
  const declineCode = String(body.decline_code ?? "");

  return type === "card_error" &&
    code === "card_declined" &&
    DEFINITIVE_CULQI_DECLINE_CODES.has(declineCode);
}

async function safeReadJson(
  response: Response,
): Promise<Record<string, unknown> | null> {
  try {
    const body = await response.json();
    return body && typeof body === "object" && !Array.isArray(body)
      ? body as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function sanitizeCulqiString(value: unknown) {
  return String(value ?? "")
    .replace(/(?:sk|pk|tkn|ype|crd)_(?:test|live)_[A-Za-z0-9]+/g, "[redacted]")
    .slice(0, 160);
}

async function getAuthorizedTestOrder(
  supabase: SupabaseLike,
  payload: ValidatedPayload,
): Promise<
  | { authorized: true; order: TestOrderRecord }
  | { authorized: false; error: string; status: number }
> {
  const { data, error } = await queryOrder(
    supabase,
    payload.storeId,
    payload.orderId,
  );

  if (error) {
    return {
      authorized: false,
      error: "No se pudo validar la orden.",
      status: 500,
    };
  }

  if (!data) {
    return {
      authorized: false,
      error: "Orden no autorizada para simulacion.",
      status: 403,
    };
  }

  if (
    data.customer_email !== TEST_ORDER_EMAIL ||
    typeof data.whatsapp_message !== "string" ||
    !data.whatsapp_message.includes(TEST_ORDER_MARKER)
  ) {
    return {
      authorized: false,
      error: "Orden no autorizada para simulacion.",
      status: 403,
    };
  }

  if (
    data.store_id !== payload.storeId ||
    data.currency !== "PEN" ||
    !Number.isSafeInteger(data.total_amount_cents) ||
    data.total_amount_cents <= 0
  ) {
    return {
      authorized: false,
      error: "Orden invalida para simulacion.",
      status: 409,
    };
  }

  return { authorized: true, order: data };
}

async function queryOrder(
  supabase: SupabaseLike,
  storeId: number,
  orderId: string,
): Promise<SupabaseResult<TestOrderRecord>> {
  return await (supabase.from("orders") as {
    select: (columns: string) => {
      eq: (column: string, value: unknown) => {
        eq: (column: string, value: unknown) => {
          maybeSingle: () => Promise<SupabaseResult<TestOrderRecord>>;
        };
      };
    };
  })
    .select(
      "id, store_id, customer_email, whatsapp_message, status, total_amount_cents, currency",
    )
    .eq("store_id", storeId)
    .eq("id", orderId)
    .maybeSingle();
}

async function findExistingAttemptId(
  supabase: SupabaseLike,
  storeId: number,
  idempotencyKey: string,
) {
  const { data, error } = await (supabase.from("payment_attempts") as {
    select: (columns: string) => {
      eq: (column: string, value: unknown) => {
        eq: (column: string, value: unknown) => {
          maybeSingle: () => Promise<SupabaseResult<{ id: string }>>;
        };
      };
    };
  })
    .select("id")
    .eq("store_id", storeId)
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();

  if (error) {
    throw new Error("No se pudo verificar la idempotencia del intento.");
  }

  return data?.id ?? null;
}

function parsePositiveInteger(value: unknown, field: string) {
  if (typeof value === "string" && !/^[1-9][0-9]*$/.test(value.trim())) {
    throw new Error(`${field} debe ser un entero positivo.`);
  }

  const numberValue = typeof value === "number" ? value : Number(value);

  if (!Number.isSafeInteger(numberValue) || numberValue <= 0) {
    throw new Error(`${field} debe ser un entero positivo.`);
  }

  return numberValue;
}

function parseUuid(value: unknown, field: string) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value.trim())) {
    throw new Error(`${field} debe ser UUID valido.`);
  }

  return value.trim();
}

function parseRequiredString(value: unknown, field: string, maxLength: number) {
  if (typeof value !== "string") {
    throw new Error(`${field} debe ser texto.`);
  }

  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${field} es requerido.`);
  }

  if (trimmed.length > maxLength) {
    throw new Error(`${field} excede el maximo de ${maxLength} caracteres.`);
  }

  return trimmed;
}

function parseOptionalString(value: unknown, field: string, maxLength: number) {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== "string") {
    throw new Error(`${field} debe ser texto.`);
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.length > maxLength) {
    throw new Error(`${field} excede el maximo de ${maxLength} caracteres.`);
  }

  return trimmed;
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

async function readLimitedBody(request: Request, maxBytes: number) {
  const contentLength = request.headers.get("content-length");
  if (contentLength && Number(contentLength) > maxBytes) {
    throw new Error("La solicitud es demasiado grande.");
  }

  if (!request.body) {
    throw new Error("Solicitud vacia.");
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    receivedBytes += value.byteLength;
    if (receivedBytes > maxBytes) {
      await reader.cancel();
      throw new Error("La solicitud es demasiado grande.");
    }

    chunks.push(value);
  }

  const body = new Uint8Array(receivedBytes);
  let offset = 0;

  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder().decode(body);
}

function parseAllowedOrigins(value: string) {
  return value
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function getCorsHeaders(origin: string | null, allowedOrigins: string[]) {
  if (
    !origin || allowedOrigins.length === 0 || !allowedOrigins.includes(origin)
  ) {
    return null;
  }

  return {
    "Access-Control-Allow-Headers":
      "authorization, content-type, x-kafka-mock-test-secret",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

async function timingSafeSecretEquals(provided: string, expected: string) {
  if (
    !provided || provided.length > 512 ||
    expected.length < MIN_TEST_RUNNER_SECRET_LENGTH
  ) {
    return false;
  }

  const encoder = new TextEncoder();
  const message = encoder.encode("kafka-create-payment-attempt-mock-v1");

  async function signature(secret: string) {
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );

    return new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
  }

  const expectedSignature = await signature(expected);
  const providedSignature = await signature(provided);
  let diff = expectedSignature.length ^ providedSignature.length;

  for (let index = 0; index < expectedSignature.length; index += 1) {
    diff |= expectedSignature[index] ^ (providedSignature[index] ?? 0);
  }

  return diff === 0;
}

function paymentAttemptJsonResponse(
  paymentAttempt: PaymentAttemptResponse,
  paymentResult: Record<string, unknown>,
  status: number,
  corsHeaders: Record<string, string> | null,
) {
  return jsonResponse(
    {
      payment_attempt: paymentAttempt,
      payment_result: paymentResult,
      mock: paymentResult,
    },
    status,
    corsHeaders,
  );
}

function jsonResponse(
  body: Record<string, unknown>,
  status: number,
  corsHeaders: Record<string, string> | null = null,
  extraHeaders: Record<string, string> = {},
) {
  return new Response(JSON.stringify(body), {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      ...(corsHeaders ?? {}),
      ...extraHeaders,
    },
    status,
  });
}

function getStatusForDatabaseError(message: string) {
  if (
    message.includes("idempotency key conflict") ||
    message.includes("payment idempotency key conflict")
  ) {
    return 409;
  }

  if (
    message.includes("intento de pago pendiente") ||
    message.includes("orden ya pagada")
  ) {
    return 409;
  }

  if (
    message.includes("tienda invalida") ||
    message.includes("orden invalida") ||
    message.includes("estado de orden invalido") ||
    message.includes("monto de orden invalido") ||
    message.includes("source Culqi TEST invalido") ||
    message.includes("email del comprador requerido") ||
    message.includes("sesion de pago") ||
    message.includes("pagos Culqi TEST no configurados")
  ) {
    return 400;
  }

  return 500;
}

function getSafeDatabaseError(message: string) {
  const allowedMessages = [
    "tienda invalida",
    "orden invalida",
    "idempotency key requerida",
    "payment idempotency key conflict",
    "la orden ya tiene un intento de pago pendiente",
    "orden ya pagada",
    "estado de orden invalido para pago",
    "estado de orden invalido para procesar pago",
    "estado de orden invalido para finalizar pago",
    "monto de orden invalido",
    "source Culqi TEST invalido",
    "email del comprador requerido para pago",
    "sesion de pago invalida",
    "sesion de pago expirada",
    "pagos Culqi TEST no configurados para la tienda",
    "transicion de intento de pago invalida",
    "intento de pago inconsistente con la orden",
    "device fingerprint invalido",
    "payload sanitizado invalido",
  ];

  if (
    allowedMessages.some((allowedMessage) => message.includes(allowedMessage))
  ) {
    return sanitizeErrorMessage(message);
  }

  return "No se pudo procesar el intento de pago.";
}

function sanitizeErrorMessage(message: string) {
  return message
    .replace(/sk_test_[A-Za-z0-9]+/g, "[redacted_private_key]")
    .replace(/pk_test_[A-Za-z0-9]+/g, "[redacted_public_key]")
    .replace(/tkn_test_[A-Za-z0-9]+/g, "[redacted_source]")
    .replace(/ype_test_[A-Za-z0-9]+/g, "[redacted_source]")
    .replace(/crd_test_[A-Za-z0-9]+/g, "[redacted_source]")
    .replace(
      /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
      "[redacted_jwt]",
    );
}

function buildMockChargeId(paymentAttemptId: string) {
  return `chr_test_mock_${compactId(paymentAttemptId)}`;
}

function buildMockProviderEventId(
  paymentAttemptId: string,
  result: MockResult,
) {
  return `evt_mock_${result}_${compactId(paymentAttemptId)}`;
}

function compactId(value: string) {
  return value.replace(/[^A-Za-z0-9]/g, "").slice(0, 48);
}
