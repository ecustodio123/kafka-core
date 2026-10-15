import {
  assertEquals,
  assertFalse,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createHandler } from "./index.ts";

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORDER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ATTEMPT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CHARGE = "chr_test_1234567890abcdef";
const SECRET = "sk_test_onlyFakeForLocalTests";
const JWT = "fake-owner-access-token";
const ORIGIN = "http://localhost:5173";
type Row = Record<string, unknown>;

function setup() {
  const rows: Record<string, Row | null> = {
    stores: { id: 1, owner_user_id: OWNER },
    payment_attempts: {
      id: ATTEMPT,
      store_id: 1,
      order_id: ORDER,
      provider: "culqi",
      environment: "test",
      currency: "PEN",
      amount_cents: 1000,
      status: "processing",
      culqi_charge_id: CHARGE,
    },
    orders: {
      id: ORDER,
      store_id: 1,
      total_amount_cents: 1000,
      currency: "PEN",
      status: "pending_payment",
    },
  };
  const env: Record<string, string> = {
    RECONCILE_PAYMENT_ATTEMPT_DIAGNOSTIC_ENABLED: "true",
    RECONCILE_PAYMENT_ATTEMPT_ALLOWED_ORIGINS: ORIGIN,
  };
  const charge: Row = {
    object: "charge",
    id: CHARGE,
    amount: 1000,
    currency_code: "PEN",
    metadata: {
      kafka_store_id: "1",
      kafka_order_id: ORDER,
      kafka_payment_attempt_id: ATTEMPT,
    },
    capture: true,
    capture_date: 1669244278000,
    paid: false,
    dispute: false,
    amount_refunded: 0,
    // Poison fields must never be reflected, even on malformed/error responses.
    source: { id: "tkn_test_sensitive", card_number: "sensitive-card" },
    email: "private-customer@example.com",
    authentication_3DS: { secret: "private-3ds" },
  };
  const calls: { method: string; url: string; init: RequestInit }[] = [];
  const reads: { table: string; filters: [string, unknown][] }[] = [];
  const rpcs: { name: string; args: Row }[] = [];
  const state = {
    user: { id: OWNER, is_anonymous: false } as {
      id: string;
      is_anonymous: boolean;
    } | null,
    authError: false,
    dbError: false,
    secret: SECRET as unknown,
    secretError: false,
    code: 200,
    throwFetch: false,
    timeout: false,
    rawResponse: null as string | null,
  };
  const db = {
    auth: {
      getUser: (token: string) => {
        assertEquals(token, JWT);
        return Promise.resolve({
          data: { user: state.user },
          error: state.authError ? { message: SECRET } : null,
        });
      },
    },
    from: (table: string) => {
      const filters: [string, unknown][] = [];
      const query = {
        select: (_columns: string) => query,
        eq: (column: string, value: unknown) => {
          filters.push([column, value]);
          return query;
        },
        maybeSingle: () => {
          reads.push({ table, filters });
          const row = rows[table];
          return Promise.resolve({
            data: row && filters.every(([key, value]) => row[key] === value)
              ? { ...row }
              : null,
            error: state.dbError ? { message: SECRET } : null,
          });
        },
      };
      return query;
    },
    rpc: (name: string, args: Row) => {
      // Any accidental reserve/finalize/write RPC causes the test to fail.
      assertEquals(name, "get_culqi_test_private_key_for_payment");
      assertEquals(args, { p_store_id: 1 });
      rpcs.push({ name, args });
      return Promise.resolve({
        data: state.secret,
        error: state.secretError ? { message: SECRET } : null,
      });
    },
  };
  const fetchMock: typeof fetch = async (input, init) => {
    assertEquals(init?.method, "GET");
    assertEquals(
      String(input),
      `https://api.culqi.com/v2/charges/${
        rows.payment_attempts!.culqi_charge_id
      }`,
    );
    assertEquals(init?.redirect, "error");
    assertEquals(
      new Headers(init?.headers).get("Authorization"),
      `Bearer ${SECRET}`,
    );
    assertEquals(init?.body, undefined);
    calls.push({ url: String(input), method: init!.method!, init: init! });
    if (state.throwFetch) throw new Error(SECRET + JWT);
    if (state.timeout) {
      await new Promise<void>((_resolve, reject) => {
        init!.signal!.addEventListener(
          "abort",
          () => reject(new Error(SECRET)),
          { once: true },
        );
      });
    }
    return new Response(state.rawResponse ?? JSON.stringify(charge), {
      status: state.code,
    });
  };
  const handler = createHandler({
    env: (name) => env[name],
    createSupabaseClient: () => db,
    fetch: fetchMock,
    timeoutMs: 10,
  });
  const post = (payload: Row = {}, headers: Record<string, string> = {}) =>
    handler(
      new Request("http://local/reconcile", {
        method: "POST",
        headers: {
          Origin: ORIGIN,
          Authorization: `Bearer ${JWT}`,
          "Content-Type": "application/json",
          ...headers,
        },
        body: JSON.stringify({
          store_id: 1,
          payment_attempt_id: ATTEMPT,
          ...payload,
        }),
      }),
    );
  return { rows, env, charge, calls, reads, rpcs, state, handler, post };
}

async function safeBody(response: Response) {
  assertEquals(response.headers.get("Cache-Control"), "no-store");
  const raw = await response.text();
  for (
    const sensitive of [
      SECRET,
      JWT,
      "tkn_test_sensitive",
      "sensitive-card",
      "private-customer",
      "private-3ds",
    ]
  ) {
    assertFalse(raw.includes(sensitive));
  }
  return JSON.parse(raw);
}

Deno.test("diagnostics defaults disabled independently of payment activation", async () => {
  const s = setup();
  delete s.env.RECONCILE_PAYMENT_ATTEMPT_DIAGNOSTIC_ENABLED;
  s.env.CREATE_PAYMENT_ATTEMPT_MODE = "culqi_test";
  assertEquals((await s.post()).status, 503);
  assertEquals(s.reads.length + s.rpcs.length + s.calls.length, 0);
});

Deno.test("disabled diagnostics reject repeated concurrent requests without accessing services", async () => {
  for (const flag of [undefined, "false", "TRUE", "1"]) {
    const s = setup();
    if (flag === undefined) {
      delete s.env.RECONCILE_PAYMENT_ATTEMPT_DIAGNOSTIC_ENABLED;
    } else s.env.RECONCILE_PAYMENT_ATTEMPT_DIAGNOSTIC_ENABLED = flag;
    const responses = await Promise.all(
      Array.from({ length: 20 }, () => s.post()),
    );
    assertEquals(
      responses.map((response) => response.status),
      Array(20).fill(503),
    );
    assertEquals(s.reads.length + s.rpcs.length + s.calls.length, 0);
    for (const response of responses) await response.body?.cancel();
  }
});

Deno.test("requires Auth-verified owner, rejects missing/invalid/anonymous JWT", async () => {
  const s = setup();
  assertEquals((await s.post({}, { Authorization: "" })).status, 401);
  s.state.authError = true;
  assertEquals((await s.post()).status, 401);
  s.state.authError = false;
  s.state.user = { id: OWNER, is_anonymous: true };
  assertEquals((await s.post()).status, 401);
  assertEquals(s.reads.length + s.rpcs.length + s.calls.length, 0);
});

Deno.test("other owner and other store are hidden before Vault or HTTP access", async () => {
  const s = setup();
  s.state.user!.id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  assertEquals((await s.post()).status, 404);
  s.state.user!.id = OWNER;
  assertEquals((await s.post({ store_id: 2 })).status, 404);
  assertEquals(s.rpcs.length + s.calls.length, 0);
  assertEquals(s.reads[0].filters, [["id", 1], [
    "owner_user_id",
    "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  ]]);
});

Deno.test("tenant-scoped attempt and associated order are verified", async () => {
  const s = setup();
  s.rows.payment_attempts!.store_id = 2;
  assertEquals((await s.post()).status, 404);
  s.rows.payment_attempts!.store_id = 1;
  s.rows.orders!.store_id = 2;
  assertEquals((await s.post()).status, 409);
  assertEquals(s.rpcs.length + s.calls.length, 0);
});

Deno.test("TEST/PEN and stored amounts must agree before accessing credentials", async () => {
  for (
    const patch of [{ environment: "live" }, { provider: "other" }, {
      currency: "USD",
    }, { amount_cents: 999 }]
  ) {
    const s = setup();
    Object.assign(s.rows.payment_attempts!, patch);
    assertEquals((await s.post()).status, 409);
    assertEquals(s.rpcs.length + s.calls.length, 0);
  }
});

Deno.test("compatible charge exposes only allowlisted observations, never marks paid", async () => {
  const s = setup();
  const before = JSON.stringify(s.rows);
  const response = await s.post();
  assertEquals(response.status, 200);
  const body = await safeBody(response);
  assertEquals(body.result, "found_compatible");
  assertEquals(body.financial_state, "not_determined");
  assertEquals(body.provider_observation, {
    capture: true,
    capture_date: 1669244278000,
    paid: false,
    dispute: false,
    amount_refunded_cents: 0,
  });
  assertEquals(body.state_modified, false);
  assertEquals(JSON.stringify(s.rows), before);
  assertEquals(s.rpcs.length, 1);
  assertEquals(s.calls.length, 1);
});

Deno.test("200 alone, even paid=true, is not capture or financial confirmation", async () => {
  const s = setup();
  s.charge.capture = false;
  s.charge.capture_date = null;
  s.charge.paid = true;
  const body = await safeBody(await s.post());
  assertEquals(body.financial_state, "not_determined");
  assertEquals(body.provider_observation.capture, false);
  assertEquals(body.provider_observation.paid, true);
});

Deno.test("missing charge ID performs no search and cannot imply failure", async () => {
  const s = setup();
  s.rows.payment_attempts!.culqi_charge_id = null;
  const body = await safeBody(await s.post());
  assertEquals(body.result, "uncertain");
  assertEquals(body.reason, "missing_charge_id_manual_review_required");
  assertEquals(s.rpcs.length + s.calls.length, 0);
});

Deno.test("charge reference cannot select LIVE, arbitrary hosts or path traversal", async () => {
  for (
    const id of [
      "chr_live_1234567890abcdef",
      "https://evil.test",
      "../charges",
      "chr_test_",
      "chr_test_" + "a".repeat(152),
      "chr_test_mock_1234567890abcdef",
      "chr_test_abc/def",
      "chr_test_abc\\def",
      "chr_test_abc..def",
      "chr_test_abc%2Fdef",
      "chr_test_abc?limit=100",
      "chr_test_abc#fragment",
      "chr_test_abc\n",
      "chr_test_abc\r\n",
      "chr_test_abc\u2028",
      " chr_test_abc",
      "chr_test_abc ",
      "chr_test_ábc",
    ]
  ) {
    const s = setup();
    s.rows.payment_attempts!.culqi_charge_id = id;
    assertEquals((await s.post()).status, 409);
    assertEquals(s.rpcs.length + s.calls.length, 0);
  }
});

Deno.test("charge IDs accept documented length and bounded existing backend references", async () => {
  for (
    const suffix of ["a", "short", "1234567890abcdef", "A0z".repeat(50) + "9"]
  ) {
    const s = setup();
    const chargeId = `chr_test_${suffix}`;
    s.rows.payment_attempts!.culqi_charge_id = chargeId;
    s.charge.id = chargeId;
    const response = await s.post();
    assertEquals(response.status, 200);
    assertEquals((await safeBody(response)).result, "found_compatible");
    assertEquals(s.calls.length, 1);
    assertEquals(s.calls[0].method, "GET");
    assertEquals(
      s.calls[0].url,
      `https://api.culqi.com/v2/charges/${chargeId}`,
    );
  }
});

Deno.test("caller cannot supply charge ID, secrets, amount or mode", async () => {
  for (const key of ["charge_id", "secret_id", "amount", "mode"]) {
    const s = setup();
    assertEquals((await s.post({ [key]: "forbidden" })).status, 400);
    assertEquals(s.rpcs.length + s.calls.length, 0);
  }
});

Deno.test("rejects unsafe IDs and oversized streamed requests", async () => {
  const s = setup();
  for (const value of [true, null, Number.MAX_SAFE_INTEGER + 1, 0, -1]) {
    assertEquals((await s.post({ store_id: value })).status, 400);
  }
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(600));
      controller.enqueue(new Uint8Array(600));
      controller.close();
    },
  });
  const response = await s.handler(
    new Request("http://local", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${JWT}`,
        "Content-Type": "application/json",
      },
      body,
    }),
  );
  assertEquals(response.status, 400);
  assertEquals(s.rpcs.length + s.calls.length, 0);
});

Deno.test("CORS, preflight and method restrictions do not replace authentication", async () => {
  const s = setup();
  assertEquals((await s.post({}, { Origin: "https://evil.test" })).status, 403);
  assertEquals(
    (await s.handler(
      new Request("http://local", {
        method: "OPTIONS",
        headers: { Origin: ORIGIN },
      }),
    )).status,
    204,
  );
  assertEquals(
    (await s.handler(new Request("http://local", { method: "GET" }))).status,
    405,
  );
  // CLI clients without Origin are still authenticated as the owner.
  assertEquals((await s.post({}, { Origin: "" })).status, 200);
});

Deno.test("provider amount, currency and ID mismatches are incompatible, not paid", async () => {
  for (
    const [field, value, expected] of [["amount", 999, "amount"], [
      "currency_code",
      "USD",
      "currency",
    ], ["id", "chr_live_1234567890abcdef", "charge_id"]]
  ) {
    const s = setup();
    s.charge[String(field)] = value;
    const body = await safeBody(await s.post());
    assertEquals(body.result, "found_incompatible");
    assertEquals(body.issues, [expected]);
    assertEquals(body.financial_state, "not_determined");
  }
});

Deno.test("metadata must match store, order and attempt; absent metadata is insufficient", async () => {
  for (
    const field of [
      "kafka_store_id",
      "kafka_order_id",
      "kafka_payment_attempt_id",
    ]
  ) {
    const s = setup();
    (s.charge.metadata as Row)[field] = "wrong-tenant-or-order";
    const body = await safeBody(await s.post());
    assertEquals(body.result, "found_incompatible");
  }
  const s = setup();
  delete s.charge.metadata;
  const body = await safeBody(await s.post());
  assertEquals(body.result, "uncertain");
  assertEquals(body.reason, "insufficient_linkage_evidence");
});

Deno.test("404, rate limits, auth errors, redirects and 5xx remain uncertain", async () => {
  for (const code of [201, 301, 400, 401, 403, 404, 429, 500]) {
    const s = setup();
    s.state.code = code;
    s.state.rawResponse = JSON.stringify({ error: SECRET + JWT });
    const body = await safeBody(await s.post());
    assertEquals(body.result, "uncertain");
    assertEquals(body.financial_state, "not_determined");
    assertEquals(s.calls.length, 1);
  }
});

Deno.test("timeout and network errors have no retries or financial mutation", async () => {
  for (const kind of ["timeout", "throwFetch"] as const) {
    const s = setup();
    s.state[kind] = true;
    const body = await safeBody(await s.post());
    assertEquals(body.result, "uncertain");
    assertEquals(
      body.reason,
      kind === "timeout" ? "provider_timeout" : "provider_network_error",
    );
    assertEquals(s.calls.length, 1);
    assertEquals(s.rpcs.length, 1);
  }
});

Deno.test("malformed or oversized provider responses cannot expose raw content", async () => {
  for (const raw of [SECRET, "null", "[]", "x".repeat(65537)]) {
    const s = setup();
    s.state.rawResponse = raw;
    const body = await safeBody(await s.post());
    assertEquals(body.result, "uncertain");
    assertEquals(s.calls.length, 1);
  }
});

Deno.test("Vault and database failures are sanitized and do not contact Culqi", async () => {
  for (const kind of ["secretError", "dbError"] as const) {
    const s = setup();
    s.state[kind] = true;
    const response = await s.post();
    assertEquals(response.status, 503);
    await safeBody(response);
    assertEquals(s.calls.length, 0);
  }
  const s = setup();
  s.state.secret = "sk_live_forbidden";
  assertEquals((await s.post()).status, 503);
  assertEquals(s.calls.length, 0);
});

Deno.test("repeated and concurrent diagnostics are read-only GETs, never charge POSTs", async () => {
  const s = setup();
  const before = JSON.stringify(s.rows);
  const responses = await Promise.all([s.post(), s.post(), s.post()]);
  for (const response of responses) {
    assertEquals((await safeBody(response)).result, "found_compatible");
  }
  assertEquals(s.calls.map((call) => call.method), ["GET", "GET", "GET"]);
  assertEquals(JSON.stringify(s.rows), before);
  assertEquals(
    s.rpcs.map((rpc) => rpc.name),
    Array(3).fill("get_culqi_test_private_key_for_payment"),
  );
});

Deno.test("paid, failed and processing attempts retain their original local state", async () => {
  for (const status of ["paid", "failed", "processing"]) {
    const s = setup();
    s.rows.payment_attempts!.status = status;
    const response = await s.post();
    assertEquals(response.status, 200);
    assertEquals(s.rows.payment_attempts!.status, status);
    assertEquals(s.rows.orders!.status, "pending_payment");
    assertStringIncludes(
      JSON.stringify(await safeBody(response)),
      '"state_modified":false',
    );
  }
});
