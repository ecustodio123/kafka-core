import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.3";

type Row = Record<string, unknown>;
type Result<T> = { data: T | null; error: unknown };
type Query = {
  select: (columns: string) => Query;
  eq: (column: string, value: unknown) => Query;
  maybeSingle: () => Promise<Result<Row>>;
};
type SupabaseLike = {
  auth: {
    getUser: (token: string) => Promise<{
      data: { user: { id: string; is_anonymous?: boolean } | null };
      error: unknown;
    }>;
  };
  from: (table: string) => Query;
  rpc: (name: string, args: Row) => Promise<Result<unknown>>;
};
type Dependencies = {
  createSupabaseClient: () => SupabaseLike | null;
  env: (name: string) => string | undefined;
  fetch: typeof fetch;
  timeoutMs?: number;
};

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Match the bounded reference contract in migration 013 (160 total characters).
// Culqi documents 25-character IDs; do not impose that narrower length here.
const CHARGE_ID = /^chr_test_[A-Za-z0-9]{1,151}$/;
const CHARGES_URL = "https://api.culqi.com/v2/charges/";
const ATTEMPT_STATUSES = [
  "created",
  "processing",
  "paid",
  "failed",
  "expired",
  "cancelled",
];
const ORDER_STATUSES = [
  "draft",
  "pending_payment",
  "paid",
  "payment_failed",
  "cancelled",
  "whatsapp_only",
];

class InvalidInput extends Error {}

export function createHandler(dependencies: Dependencies) {
  return async (request: Request): Promise<Response> => {
    const origin = request.headers.get("origin");
    const allowed =
      (dependencies.env("RECONCILE_PAYMENT_ATTEMPT_ALLOWED_ORIGINS") ?? "")
        .split(",").map((value) => value.trim()).filter(Boolean);
    // Non-browser administrative clients still require a verified owner JWT.
    const originAllowed = !origin || allowed.includes(origin);
    const cors: Record<string, string> = origin && originAllowed
      ? {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Headers":
          "authorization, content-type, apikey, x-client-info",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        Vary: "Origin",
      }
      : {};
    const reply = (body: Row, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: {
          ...cors,
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          Vary: "Origin",
        },
      });

    if (!originAllowed) return reply({ error: "Origin no permitido." }, 403);
    if (
      dependencies.env("RECONCILE_PAYMENT_ATTEMPT_DIAGNOSTIC_ENABLED") !==
        "true"
    ) {
      return reply({ error: "Diagnostico deshabilitado." }, 503);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== "POST") {
      return reply({ error: "Metodo no permitido." }, 405);
    }

    const authorization = request.headers.get("authorization") ?? "";
    const bearer = /^Bearer ([^\s]+)$/i.exec(authorization);
    if (!bearer || authorization.length > 4096) {
      return reply({ error: "Autenticacion requerida." }, 401);
    }
    if (
      request.headers.get("content-type")?.split(";")[0].trim()
        .toLowerCase() !== "application/json"
    ) {
      return reply({ error: "Se requiere application/json." }, 415);
    }

    try {
      let payload: unknown;
      try {
        payload = JSON.parse(await limitedText(request.body, 1024));
      } catch {
        throw new InvalidInput();
      }
      if (
        !isObject(payload) ||
        Object.keys(payload).some((key) =>
          !["store_id", "payment_attempt_id"].includes(key)
        )
      ) {
        throw new InvalidInput();
      }
      const storeId = typeof payload.store_id === "number"
        ? payload.store_id
        : typeof payload.store_id === "string" &&
            /^[1-9][0-9]*$/.test(payload.store_id)
        ? Number(payload.store_id)
        : NaN;
      if (
        !Number.isSafeInteger(storeId) || storeId <= 0 ||
        typeof payload.payment_attempt_id !== "string" ||
        !UUID.test(payload.payment_attempt_id)
      ) {
        throw new InvalidInput();
      }
      const attemptId = payload.payment_attempt_id.toLowerCase();
      const db = dependencies.createSupabaseClient();
      if (!db) {
        return reply({ error: "Configuracion de servidor incompleta." }, 503);
      }

      // getUser verifies the access token with Supabase Auth; never trust decoded claims alone.
      const auth = await db.auth.getUser(bearer[1]);
      const user = auth.data?.user;
      if (
        auth.error || !user || !UUID.test(user.id) || user.is_anonymous === true
      ) {
        return reply({ error: "Autenticacion invalida." }, 401);
      }
      const store = await db.from("stores").select("id, owner_user_id")
        .eq("id", storeId).eq("owner_user_id", user.id).maybeSingle();
      if (store.error) {
        return reply({ error: "No se pudo verificar el acceso." }, 503);
      }
      if (
        !store.data || store.data.id !== storeId ||
        store.data.owner_user_id !== user.id
      ) {
        return reply({ error: "Recurso no disponible." }, 404);
      }

      const attempt = await db.from("payment_attempts")
        .select(
          "id, store_id, order_id, provider, environment, amount_cents, currency, status, culqi_charge_id",
        )
        .eq("store_id", storeId).eq("id", attemptId).maybeSingle();
      if (attempt.error) {
        return reply({ error: "No se pudo consultar el intento." }, 503);
      }
      const a = attempt.data;
      if (!a || a.id !== attemptId || a.store_id !== storeId) {
        return reply({ error: "Recurso no disponible." }, 404);
      }
      if (
        a.provider !== "culqi" || a.environment !== "test" ||
        a.currency !== "PEN" ||
        !isPositiveCents(a.amount_cents) || typeof a.order_id !== "string" ||
        !UUID.test(a.order_id) ||
        !ATTEMPT_STATUSES.includes(String(a.status))
      ) {
        return reply(
          { error: "Intento incompatible con diagnostico TEST." },
          409,
        );
      }
      const order = await db.from("orders").select(
        "id, store_id, total_amount_cents, currency, status",
      )
        .eq("store_id", storeId).eq("id", a.order_id).maybeSingle();
      if (order.error) {
        return reply({ error: "No se pudo consultar la orden." }, 503);
      }
      const o = order.data;
      if (
        !o || o.id !== a.order_id || o.store_id !== storeId ||
        o.currency !== "PEN" ||
        o.total_amount_cents !== a.amount_cents ||
        !ORDER_STATUSES.includes(String(o.status))
      ) {
        return reply({ error: "Orden e intento incompatibles." }, 409);
      }

      const base = {
        diagnostic_only: true,
        environment: "test",
        store_id: storeId,
        order_id: a.order_id,
        payment_attempt_id: attemptId,
        state_modified: false,
        financial_state: "not_determined",
      };
      const uncertain = (reason: string) =>
        reply({ ...base, result: "uncertain", reason });
      if (a.culqi_charge_id === null) {
        return uncertain("missing_charge_id_manual_review_required");
      }
      if (
        typeof a.culqi_charge_id !== "string" ||
        a.culqi_charge_id.trim() !== a.culqi_charge_id ||
        !CHARGE_ID.test(a.culqi_charge_id)
      ) {
        return reply({ error: "Referencia de cargo TEST invalida." }, 409);
      }

      // Only this read-only RPC is allowed. No reserve, claim, finalize, writes or refresh.
      const secret = await db.rpc("get_culqi_test_private_key_for_payment", {
        p_store_id: storeId,
      });
      if (
        secret.error || typeof secret.data !== "string" ||
        !/^sk_test_[A-Za-z0-9]+$/.test(secret.data)
      ) {
        return reply({ error: "Credencial TEST no disponible." }, 503);
      }

      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        dependencies.timeoutMs ?? 5000,
      );
      try {
        const response = await dependencies.fetch(
          CHARGES_URL + a.culqi_charge_id,
          {
            method: "GET",
            headers: {
              Authorization: `Bearer ${secret.data}`,
              Accept: "application/json",
            },
            redirect: "error",
            signal: controller.signal,
          },
        );
        if (response.status !== 200) {
          await response.body?.cancel();
          return uncertain(
            response.status === 404
              ? "charge_not_found_not_proof_of_failure"
              : "provider_error",
          );
        }
        let charge: unknown;
        try {
          charge = JSON.parse(await limitedText(response.body, 65536));
        } catch {
          return uncertain("invalid_provider_response");
        }
        if (!isObject(charge)) return uncertain("invalid_provider_response");
        const issues: string[] = [];
        const missing: string[] = [];
        const check = (value: unknown, expected: unknown, field: string) => {
          if (value === undefined || value === null) missing.push(field);
          else if (value !== expected) issues.push(field);
        };
        check(charge.object, "charge", "object");
        check(charge.id, a.culqi_charge_id, "charge_id");
        check(charge.amount, a.amount_cents, "amount");
        check(charge.currency_code, "PEN", "currency");
        if (
          charge.metadata !== undefined && charge.metadata !== null &&
          !isObject(charge.metadata)
        ) {
          issues.push("metadata");
        }
        const metadata = isObject(charge.metadata) ? charge.metadata : {};
        check(metadata.kafka_store_id, String(storeId), "metadata_store");
        check(metadata.kafka_order_id, a.order_id, "metadata_order");
        check(metadata.kafka_payment_attempt_id, attemptId, "metadata_attempt");

        if (issues.length) {
          return reply({ ...base, result: "found_incompatible", issues });
        }
        if (missing.length) {
          return reply({
            ...base,
            result: "uncertain",
            reason: "insufficient_linkage_evidence",
            missing,
          });
        }

        // Observations are not accounting conclusions; provider paid/capture semantics differ.
        // Never return the raw charge: it includes card/source details and personal data.
        const capture = typeof charge.capture === "boolean"
          ? charge.capture
          : null;
        const captureDate = Number.isSafeInteger(charge.capture_date) &&
            Number(charge.capture_date) > 0
          ? charge.capture_date
          : null;
        return reply({
          ...base,
          result: "found_compatible",
          evidence: "identity_amount_currency_and_metadata_match",
          provider_observation: {
            capture,
            capture_date: captureDate,
            paid: typeof charge.paid === "boolean" ? charge.paid : null,
            dispute: typeof charge.dispute === "boolean"
              ? charge.dispute
              : null,
            amount_refunded_cents: isNonnegativeCents(charge.amount_refunded) &&
                Number(charge.amount_refunded) <= a.amount_cents
              ? charge.amount_refunded
              : null,
          },
        });
      } catch {
        return uncertain(
          controller.signal.aborted
            ? "provider_timeout"
            : "provider_network_error",
        );
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      // Deliberately do not serialize third-party exceptions, JWTs or response bodies.
      return reply({
        error: error instanceof InvalidInput
          ? "Solicitud invalida."
          : "Diagnostico no disponible.",
      }, error instanceof InvalidInput ? 400 : 503);
    }
  };
}

async function limitedText(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
) {
  if (!body) throw new Error("empty");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new Error("size");
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

function isObject(value: unknown): value is Row {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isNonnegativeCents(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) &&
    value >= 0 && value <= 2147483647;
}
function isPositiveCents(value: unknown): value is number {
  return isNonnegativeCents(value) && value > 0;
}

export const handler = createHandler({
  env: (name) => Deno.env.get(name),
  fetch: (input, init) => fetch(input, init),
  createSupabaseClient: () => {
    const url = Deno.env.get("SUPABASE_URL");
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !key) return null;
    return createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    }) as unknown as SupabaseLike;
  },
});

if (import.meta.main) serve(handler);
