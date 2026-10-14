import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.3";

type GetOrderPaymentStatusPayload = {
  store_id?: unknown;
  order_id?: unknown;
  payment_session_token?: unknown;
};

type ValidatedPayload = {
  storeId: number;
  orderId: string;
  paymentSessionToken: string;
};

type SupabaseResult<T> = {
  data: T | null;
  error: { message: string } | null;
};

type SupabaseLike = {
  rpc: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<SupabaseResult<unknown>>;
};

type HandlerDependencies = {
  createSupabaseClient: () => SupabaseLike | null;
  env: (name: string) => string | undefined;
};

const MAX_BODY_BYTES = 2048;
const MAX_PAYMENT_SESSION_TOKEN_LENGTH = 256;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createHandler(dependencies: HandlerDependencies) {
  return async (request: Request) => {
    const origin = request.headers.get("origin");
    const allowedOrigins = parseAllowedOrigins(
      dependencies.env("GET_ORDER_PAYMENT_STATUS_ALLOWED_ORIGINS") ??
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
      const rawBody = await readLimitedBody(request, MAX_BODY_BYTES);
      const payload = validatePayload(
        JSON.parse(rawBody) as GetOrderPaymentStatusPayload,
      );

      const supabase = dependencies.createSupabaseClient();
      if (!supabase) {
        return jsonResponse(
          { error: "Configuracion de servidor incompleta." },
          500,
          corsHeaders,
        );
      }

      const tokenHash = await sha256Hex(payload.paymentSessionToken);
      const statusResult = await supabase.rpc(
        "get_order_payment_status_for_session",
        {
          p_store_id: payload.storeId,
          p_order_id: payload.orderId,
          p_token_hash: tokenHash,
        },
      );

      if (statusResult.error) {
        return jsonResponse(
          { error: getSafeDatabaseError(statusResult.error.message) },
          400,
          corsHeaders,
        );
      }

      const status = statusResult.data;
      if (!isObject(status) || status.valid !== true) {
        return jsonResponse(
          { error: "Sesion de pago invalida." },
          401,
          corsHeaders,
        );
      }

      return jsonResponse(status as Record<string, unknown>, 200, corsHeaders);
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
          "X-Client-Info": "kafka-payments-order-status",
        },
      },
    }) as unknown as SupabaseLike;
  },
  env: (name: string) => Deno.env.get(name) ?? undefined,
};

export const handler = createHandler(defaultDependencies);

if (import.meta.main) {
  serve(handler);
}

function validatePayload(
  payload: GetOrderPaymentStatusPayload,
): ValidatedPayload {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Payload invalido.");
  }

  for (const field of Object.keys(payload)) {
    if (!["store_id", "order_id", "payment_session_token"].includes(field)) {
      throw new Error(`${field} no esta permitido.`);
    }
  }

  return {
    storeId: parsePositiveInteger(payload.store_id, "store_id"),
    orderId: parseUuid(payload.order_id, "order_id"),
    paymentSessionToken: parseRequiredString(
      payload.payment_session_token,
      "payment_session_token",
      MAX_PAYMENT_SESSION_TOKEN_LENGTH,
    ),
  };
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

function getSafeDatabaseError(message: string) {
  const allowedMessages = [
    "sesion de pago invalida",
    "tienda invalida",
    "orden invalida",
  ];

  if (
    allowedMessages.some((allowedMessage) => message.includes(allowedMessage))
  ) {
    return sanitizeErrorMessage(message);
  }

  return "No se pudo consultar el estado del pago.";
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

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
