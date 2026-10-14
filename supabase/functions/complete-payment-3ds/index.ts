import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.3";

type CompletePayment3dsPayload = {
  store_id?: unknown;
  order_id?: unknown;
  payment_attempt_id?: unknown;
  payment_session_token?: unknown;
  source_id?: unknown;
  device_finger_print_id?: unknown;
  authentication_3DS?: unknown;
};

type Authentication3ds = {
  eci: string;
  xid: string;
  cavv: string;
  protocolVersion: string;
  directoryServerTransactionId: string;
};

type ValidatedPayload = {
  storeId: number;
  orderId: string;
  paymentAttemptId: string;
  paymentSessionToken: string;
  sourceId: string;
  deviceFingerPrintId: string;
  authentication3ds: Authentication3ds;
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

type OrderRecord = {
  id: string;
  store_id: number;
  customer_email: string | null;
  status: string;
  total_amount_cents: number;
  currency: string;
};

type PaymentAttemptRecord = {
  id: string;
  order_id: string;
  store_id: number;
  provider: string;
  environment: string;
  status: string;
  amount_cents: number;
  currency: string;
  culqi_charge_id: string | null;
  failure_code: string | null;
  failure_message: string | null;
  provider_reference: string | null;
  requires_3ds: boolean;
  three_ds_status: string | null;
  reconciliation_required: boolean;
  created_at: string;
  updated_at: string;
};

type PaymentSessionRecord = {
  store_id: number;
  order_id: string;
  status: string;
  expires_at: string;
  created_at: string;
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
  now: () => Date;
};

const MAX_BODY_BYTES = 4096;
const MAX_PAYMENT_SESSION_TOKEN_LENGTH = 256;
const MAX_SOURCE_ID_LENGTH = 120;
const MAX_DEVICE_FINGER_PRINT_LENGTH = 64;
const DEFAULT_CULQI_CHARGES_URL = "https://api.culqi.com/v2/charges";
const DEFAULT_CULQI_TIMEOUT_MS = 8000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEVICE_FINGER_PRINT_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TEST_SOURCE_PATTERN = /^(tkn|ype|crd)_test_[A-Za-z0-9]+$/;
const ECI_PATTERN = /^[0-9]{2}$/;
const SAFE_3DS_VALUE_PATTERN = /^[A-Za-z0-9._:-]+$/;
const PROTOCOL_VERSION_PATTERN = /^[0-9]+(?:\.[0-9]+){1,2}$/;
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
const FORBIDDEN_CLIENT_FIELDS = new Set([
  "amount",
  "amount_cents",
  "currency",
  "currency_code",
  "price",
  "total",
  "status",
  "final_status",
  "payment_result",
  "mock_result",
]);

export function createHandler(dependencies: HandlerDependencies) {
  return async (request: Request) => {
    const origin = request.headers.get("origin");
    const allowedOrigins = parseAllowedOrigins(
      dependencies.env("COMPLETE_PAYMENT_3DS_ALLOWED_ORIGINS") ??
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
      readRuntimeConfig(dependencies.env);
      const rawBody = await readLimitedBody(request, MAX_BODY_BYTES);
      const payload = validatePayload(
        JSON.parse(rawBody) as CompletePayment3dsPayload,
      );

      const supabase = dependencies.createSupabaseClient();
      if (!supabase) {
        return jsonResponse(
          { error: "Configuracion de servidor incompleta." },
          500,
          corsHeaders,
        );
      }

      return await processCompletePayment3ds(
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

async function processCompletePayment3ds(
  supabase: SupabaseLike,
  payload: ValidatedPayload,
  dependencies: HandlerDependencies,
  corsHeaders: Record<string, string>,
) {
  const sessionTokenHash = await sha256Hex(payload.paymentSessionToken);
  const sessionResult = await queryPaymentSession(
    supabase,
    payload.storeId,
    payload.orderId,
    sessionTokenHash,
  );

  if (sessionResult.error) {
    return jsonResponse(
      { error: "No se pudo validar la sesion de pago." },
      500,
      corsHeaders,
    );
  }

  if (!isSessionUsableFor3ds(sessionResult.data, dependencies.now())) {
    return jsonResponse(
      { error: "Sesion de pago invalida." },
      401,
      corsHeaders,
    );
  }

  const orderResult = await queryOrder(
    supabase,
    payload.storeId,
    payload.orderId,
  );
  if (orderResult.error) {
    return jsonResponse(
      { error: "No se pudo validar la orden." },
      500,
      corsHeaders,
    );
  }

  const order = orderResult.data;
  if (!order || order.store_id !== payload.storeId) {
    return jsonResponse({ error: "Orden invalida." }, 404, corsHeaders);
  }

  const attemptResult = await queryPaymentAttempt(
    supabase,
    payload.storeId,
    payload.orderId,
    payload.paymentAttemptId,
  );
  if (attemptResult.error) {
    return jsonResponse(
      { error: "No se pudo validar el intento de pago." },
      500,
      corsHeaders,
    );
  }

  const attempt = attemptResult.data;
  if (!attempt || attempt.store_id !== payload.storeId) {
    return jsonResponse(
      { error: "Intento de pago invalido." },
      404,
      corsHeaders,
    );
  }

  if (order.status === "paid" || attempt.status === "paid") {
    return paymentAttemptJsonResponse(
      buildExistingAttemptResponse(order, attempt),
      {
        mode: "culqi_test_3ds",
        processed: false,
        reason: "already_paid",
      },
      200,
      corsHeaders,
    );
  }

  if (
    order.status !== "pending_payment" ||
    !order.customer_email ||
    order.currency !== "PEN" ||
    !Number.isSafeInteger(order.total_amount_cents) ||
    order.total_amount_cents <= 0
  ) {
    return jsonResponse(
      { error: "Orden invalida para completar 3DS." },
      409,
      corsHeaders,
    );
  }

  if (
    attempt.provider !== "culqi" ||
    attempt.environment !== "test" ||
    attempt.status !== "processing" ||
    attempt.amount_cents !== order.total_amount_cents ||
    attempt.currency !== order.currency ||
    attempt.requires_3ds !== true ||
    !["required", "completion_processing"].includes(
      attempt.three_ds_status ?? "",
    )
  ) {
    return jsonResponse(
      { error: "Intento 3DS invalido." },
      409,
      corsHeaders,
    );
  }

  const sourceValidation = await supabase.rpc(
    "validate_payment_attempt_source",
    {
      p_store_id: payload.storeId,
      p_payment_attempt_id: payload.paymentAttemptId,
      p_culqi_source_id: payload.sourceId,
    },
  );

  if (sourceValidation.error || sourceValidation.data !== true) {
    return jsonResponse(
      { error: "Validacion de intento de pago invalida." },
      409,
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
    "claim_kafka_payment_attempt_3ds_completion",
    {
      p_store_id: payload.storeId,
      p_payment_attempt_id: payload.paymentAttemptId,
      p_device_fingerprint_id: payload.deviceFingerPrintId,
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
  const claimedAttempt = claim.payment_attempt;
  if (claim.acquired !== true) {
    return paymentAttemptJsonResponse(
      claimedAttempt,
      {
        mode: "culqi_test_3ds",
        processed: false,
        reason: claim.reason,
      },
      claim.reason === "already_processing" ? 202 : 200,
      corsHeaders,
    );
  }

  const culqiResponse = await createCulqi3dsCharge({
    amountCents: claimedAttempt.amount_cents,
    authentication3ds: payload.authentication3ds,
    chargesUrl: readCulqiChargesUrl(dependencies.env),
    currency: claimedAttempt.currency,
    deviceFingerPrintId: payload.deviceFingerPrintId,
    email: order.customer_email,
    fetchImpl: dependencies.fetch,
    orderId: payload.orderId,
    paymentAttemptId: claimedAttempt.id,
    privateKey: privateKeyResult.data,
    sourceId: payload.sourceId,
    storeId: payload.storeId,
    timeoutMs: readTimeoutMs(dependencies.env),
  });

  if (culqiResponse.kind === "success") {
    const finalizeResult = await supabase.rpc(
      "finalize_kafka_payment_attempt",
      {
        p_store_id: payload.storeId,
        p_payment_attempt_id: claimedAttempt.id,
        p_final_status: "paid",
        p_culqi_charge_id: culqiResponse.chargeId,
        p_failure_code: null,
        p_failure_message: null,
        p_provider_event_id: `culqi-3ds-charge-${culqiResponse.chargeId}`,
        p_provider_reference: culqiResponse.chargeId,
        p_sanitized_payload: culqiResponse.sanitizedPayload,
      },
    );

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
        mode: "culqi_test_3ds",
        processed: true,
        reason: "culqi_3ds_charge_paid",
      },
      201,
      corsHeaders,
    );
  }

  if (culqiResponse.kind === "definitive_failure") {
    const finalizeResult = await supabase.rpc(
      "finalize_kafka_payment_attempt",
      {
        p_store_id: payload.storeId,
        p_payment_attempt_id: claimedAttempt.id,
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
      return jsonResponse(
        { error: getSafeDatabaseError(finalizeResult.error.message) },
        getStatusForDatabaseError(finalizeResult.error.message),
        corsHeaders,
      );
    }

    return paymentAttemptJsonResponse(
      finalizeResult.data as PaymentAttemptResponse,
      {
        mode: "culqi_test_3ds",
        processed: true,
        reason: "culqi_3ds_definitive_failure",
      },
      402,
      corsHeaders,
    );
  }

  return paymentAttemptJsonResponse(
    claimedAttempt,
    {
      mode: "culqi_test_3ds",
      processed: true,
      reason: culqiResponse.reason,
      requires_reconciliation: true,
    },
    202,
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
          "X-Client-Info": "kafka-payments-complete-payment-3ds",
        },
      },
    }) as unknown as SupabaseLike;
  },
  env: (name: string) => Deno.env.get(name) ?? undefined,
  fetch: fetch.bind(globalThis),
  now: () => new Date(),
};

export const handler = createHandler(defaultDependencies);

if (import.meta.main) {
  serve(handler);
}

function validatePayload(
  payload: CompletePayment3dsPayload,
): ValidatedPayload {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Payload invalido.");
  }

  for (const field of Object.keys(payload)) {
    if (
      ![
        "store_id",
        "order_id",
        "payment_attempt_id",
        "payment_session_token",
        "source_id",
        "device_finger_print_id",
        "authentication_3DS",
      ].includes(field)
    ) {
      throw new Error(`${field} no esta permitido.`);
    }

    if (FORBIDDEN_CLIENT_FIELDS.has(field)) {
      throw new Error(`${field} no esta permitido.`);
    }
  }

  const sourceId = parseRequiredString(
    payload.source_id,
    "source_id",
    MAX_SOURCE_ID_LENGTH,
  );
  const deviceFingerPrintId = parseRequiredString(
    payload.device_finger_print_id,
    "device_finger_print_id",
    MAX_DEVICE_FINGER_PRINT_LENGTH,
  );

  if (!TEST_SOURCE_PATTERN.test(sourceId)) {
    throw new Error("source_id Culqi TEST invalido.");
  }

  if (!DEVICE_FINGER_PRINT_PATTERN.test(deviceFingerPrintId)) {
    throw new Error("device_finger_print_id invalido.");
  }

  return {
    storeId: parsePositiveInteger(payload.store_id, "store_id"),
    orderId: parseUuid(payload.order_id, "order_id"),
    paymentAttemptId: parseUuid(
      payload.payment_attempt_id,
      "payment_attempt_id",
    ),
    paymentSessionToken: parseRequiredString(
      payload.payment_session_token,
      "payment_session_token",
      MAX_PAYMENT_SESSION_TOKEN_LENGTH,
    ),
    sourceId,
    deviceFingerPrintId,
    authentication3ds: parseAuthentication3ds(payload.authentication_3DS),
  };
}

function parseAuthentication3ds(value: unknown): Authentication3ds {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("authentication_3DS invalido.");
  }

  const input = value as Record<string, unknown>;
  for (const field of Object.keys(input)) {
    if (
      ![
        "eci",
        "xid",
        "cavv",
        "protocolVersion",
        "directoryServerTransactionId",
      ].includes(field)
    ) {
      throw new Error(`authentication_3DS.${field} no esta permitido.`);
    }
  }

  const eci = parseRequiredString(input.eci, "authentication_3DS.eci", 2);
  const xid = parseRequiredString(input.xid, "authentication_3DS.xid", 128);
  const cavv = parseRequiredString(input.cavv, "authentication_3DS.cavv", 256);
  const protocolVersion = parseRequiredString(
    input.protocolVersion,
    "authentication_3DS.protocolVersion",
    16,
  );
  const directoryServerTransactionId = parseRequiredString(
    input.directoryServerTransactionId,
    "authentication_3DS.directoryServerTransactionId",
    64,
  );

  if (!ECI_PATTERN.test(eci)) {
    throw new Error("authentication_3DS.eci invalido.");
  }

  if (
    !SAFE_3DS_VALUE_PATTERN.test(xid) ||
    !SAFE_3DS_VALUE_PATTERN.test(cavv)
  ) {
    throw new Error("authentication_3DS invalido.");
  }

  if (!PROTOCOL_VERSION_PATTERN.test(protocolVersion)) {
    throw new Error("authentication_3DS.protocolVersion invalido.");
  }

  if (!DEVICE_FINGER_PRINT_PATTERN.test(directoryServerTransactionId)) {
    throw new Error(
      "authentication_3DS.directoryServerTransactionId invalido.",
    );
  }

  return { eci, xid, cavv, protocolVersion, directoryServerTransactionId };
}

function readRuntimeConfig(env: HandlerDependencies["env"]) {
  if (env("COMPLETE_PAYMENT_3DS_ENABLED") !== "true") {
    throw new Error("complete-payment-3ds no esta habilitado.");
  }

  if (env("COMPLETE_PAYMENT_3DS_MODE") !== "culqi_test") {
    throw new Error("COMPLETE_PAYMENT_3DS_MODE invalido.");
  }
}

function readTimeoutMs(env: HandlerDependencies["env"]) {
  const rawValue = env("COMPLETE_PAYMENT_3DS_CULQI_TIMEOUT_MS");

  if (!rawValue) {
    return DEFAULT_CULQI_TIMEOUT_MS;
  }

  const timeoutMs = Number(rawValue);
  if (
    !Number.isSafeInteger(timeoutMs) || timeoutMs < 2000 || timeoutMs > 15000
  ) {
    throw new Error("COMPLETE_PAYMENT_3DS_CULQI_TIMEOUT_MS invalido.");
  }

  return timeoutMs;
}

function readCulqiChargesUrl(env: HandlerDependencies["env"]) {
  const configuredUrl = env("COMPLETE_PAYMENT_3DS_CULQI_CHARGES_URL") ??
    DEFAULT_CULQI_CHARGES_URL;

  if (configuredUrl !== DEFAULT_CULQI_CHARGES_URL) {
    throw new Error("COMPLETE_PAYMENT_3DS_CULQI_CHARGES_URL invalido.");
  }

  return configuredUrl;
}

type CulqiChargeResult =
  | {
    kind: "success";
    chargeId: string;
    sanitizedPayload: Record<string, unknown>;
  }
  | {
    kind: "definitive_failure";
    failureCode: string;
    failureMessage: string;
    sanitizedPayload: Record<string, unknown>;
  }
  | {
    kind: "uncertain";
    reason: string;
  };

async function createCulqi3dsCharge({
  amountCents,
  authentication3ds,
  chargesUrl,
  currency,
  deviceFingerPrintId,
  email,
  fetchImpl,
  orderId,
  paymentAttemptId,
  privateKey,
  sourceId,
  storeId,
  timeoutMs,
}: {
  amountCents: number;
  authentication3ds: Authentication3ds;
  chargesUrl: string;
  currency: string;
  deviceFingerPrintId: string;
  email: string;
  fetchImpl: typeof fetch;
  orderId: string;
  paymentAttemptId: string;
  privateKey: string;
  sourceId: string;
  storeId: number;
  timeoutMs: number;
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
        authentication_3DS: authentication3ds,
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
      const chargeId = typeof body?.id === "string" ? body.id : "";
      if (!/^chr_test_[A-Za-z0-9]+$/.test(chargeId)) {
        return { kind: "uncertain", reason: "culqi_success_without_charge_id" };
      }

      return {
        kind: "success",
        chargeId,
        sanitizedPayload: {
          culqi_charge_id: chargeId,
          culqi_status: response.status,
          object: sanitizeCulqiString(body?.object),
          three_ds_completed: true,
        },
      };
    }

    if (response.status === 400 || response.status === 402) {
      if (!isDefinitiveCulqiCardDecline(body)) {
        return {
          kind: "uncertain",
          reason: `culqi_3ds_ambiguous_${response.status}`,
        };
      }

      const failureCode = sanitizeCulqiString(body?.decline_code ?? body?.code);
      const failureMessage = sanitizeCulqiString(
        body?.merchant_message ?? body?.user_message ??
          "Pago 3DS rechazado por Culqi.",
      );

      return {
        kind: "definitive_failure",
        failureCode,
        failureMessage,
        sanitizedPayload: {
          culqi_status: response.status,
          code: failureCode,
          type: sanitizeCulqiString(body?.type),
          three_ds_completed: true,
        },
      };
    }

    return {
      kind: "uncertain",
      reason: `culqi_3ds_http_${response.status}`,
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return { kind: "uncertain", reason: "culqi_3ds_timeout" };
    }

    return { kind: "uncertain", reason: "culqi_3ds_network_error" };
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

async function queryPaymentSession(
  supabase: SupabaseLike,
  storeId: number,
  orderId: string,
  tokenHash: string,
): Promise<SupabaseResult<PaymentSessionRecord>> {
  return await (supabase.from("order_payment_sessions") as {
    select: (columns: string) => {
      eq: (column: string, value: unknown) => {
        eq: (column: string, value: unknown) => {
          eq: (column: string, value: unknown) => {
            maybeSingle: () => Promise<SupabaseResult<PaymentSessionRecord>>;
          };
        };
      };
    };
  })
    .select("store_id, order_id, status, expires_at, created_at")
    .eq("store_id", storeId)
    .eq("order_id", orderId)
    .eq("token_hash", tokenHash)
    .maybeSingle();
}

function isSessionUsableFor3ds(
  session: PaymentSessionRecord | null,
  now: Date,
) {
  if (!session) {
    return false;
  }

  if (session.status === "active") {
    const expiresAt = new Date(session.expires_at).getTime();
    return Number.isFinite(expiresAt) && expiresAt > now.getTime();
  }

  return false;
}

async function queryOrder(
  supabase: SupabaseLike,
  storeId: number,
  orderId: string,
): Promise<SupabaseResult<OrderRecord>> {
  return await (supabase.from("orders") as {
    select: (columns: string) => {
      eq: (column: string, value: unknown) => {
        eq: (column: string, value: unknown) => {
          maybeSingle: () => Promise<SupabaseResult<OrderRecord>>;
        };
      };
    };
  })
    .select(
      "id, store_id, customer_email, status, total_amount_cents, currency",
    )
    .eq("store_id", storeId)
    .eq("id", orderId)
    .maybeSingle();
}

async function queryPaymentAttempt(
  supabase: SupabaseLike,
  storeId: number,
  orderId: string,
  paymentAttemptId: string,
): Promise<SupabaseResult<PaymentAttemptRecord>> {
  return await (supabase.from("payment_attempts") as {
    select: (columns: string) => {
      eq: (column: string, value: unknown) => {
        eq: (column: string, value: unknown) => {
          eq: (column: string, value: unknown) => {
            maybeSingle: () => Promise<SupabaseResult<PaymentAttemptRecord>>;
          };
        };
      };
    };
  })
    .select(
      [
        "id",
        "order_id",
        "store_id",
        "provider",
        "environment",
        "status",
        "amount_cents",
        "currency",
        "culqi_charge_id",
        "failure_code",
        "failure_message",
        "provider_reference",
        "requires_3ds",
        "three_ds_status",
        "reconciliation_required",
        "created_at",
        "updated_at",
      ].join(", "),
    )
    .eq("store_id", storeId)
    .eq("order_id", orderId)
    .eq("id", paymentAttemptId)
    .maybeSingle();
}

function buildExistingAttemptResponse(
  order: OrderRecord,
  attempt: PaymentAttemptRecord,
): PaymentAttemptResponse {
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
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
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
    message.includes("pagos Culqi TEST no configurados") ||
    message.includes("intento 3DS invalido") ||
    message.includes("device fingerprint invalido")
  ) {
    return 400;
  }

  return 500;
}

function getSafeDatabaseError(message: string) {
  const allowedMessages = [
    "tienda invalida",
    "orden invalida",
    "payment idempotency key conflict",
    "la orden ya tiene un intento de pago pendiente",
    "orden ya pagada",
    "estado de orden invalido para pago",
    "estado de orden invalido para finalizar pago",
    "monto de orden invalido",
    "source Culqi TEST invalido",
    "email del comprador requerido para pago",
    "sesion de pago invalida",
    "pagos Culqi TEST no configurados para la tienda",
    "transicion de intento de pago invalida",
    "intento de pago inconsistente con la orden",
    "intento 3DS invalido",
    "device fingerprint invalido",
  ];

  if (
    allowedMessages.some((allowedMessage) => message.includes(allowedMessage))
  ) {
    return sanitizeErrorMessage(message);
  }

  return "No se pudo completar el pago 3DS.";
}

function sanitizeCulqiString(value: unknown) {
  return String(value ?? "")
    .replace(/(?:sk|pk|tkn|ype|crd)_(?:test|live)_[A-Za-z0-9]+/g, "[redacted]")
    .slice(0, 160);
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
