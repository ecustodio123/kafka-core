import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const migrationPath =
  new URL("../supabase/migrations/202610130011_payment_3ds_metadata_and_status.sql", import.meta.url);
const sql = readFileSync(migrationPath, "utf8");

function functionBody(name) {
  const pattern = new RegExp(
    `create or replace function public\\.${name}[\\s\\S]*?\\nend;\\n\\$\\$;`,
    "i",
  );
  const match = sql.match(pattern);
  assert.ok(match, `missing function ${name}`);
  return match[0];
}

test("mark 3DS is idempotent only before claim and rejects later 3DS states", () => {
  const body = functionBody("mark_kafka_payment_attempt_requires_3ds");

  assert.match(body, /locked_attempt\.requires_3ds = true[\s\S]*locked_attempt\.three_ds_status = 'required'/);
  assert.match(body, /three_ds_device_fingerprint_hash is not distinct from device_fingerprint_hash/);
  assert.match(body, /or locked_attempt\.three_ds_status is not null[\s\S]*raise exception 'intento 3DS invalido'/);
  assert.match(body, /status <> 'processing'/);
});

test("claim 3DS keeps orders before payment_attempts lock order", () => {
  const body = functionBody("claim_kafka_payment_attempt_3ds_completion");
  const orderLock = body.indexOf("from public.orders");
  const attemptLock = body.indexOf("from public.payment_attempts", orderLock);

  assert.ok(orderLock > -1, "claim must lock orders");
  assert.ok(attemptLock > orderLock, "claim must lock payment_attempts after orders");
  assert.match(body, /three_ds_status = 'completion_processing'/);
  assert.match(body, /reason', 'already_processing'/);
});

test("status RPC validates session without consuming payment sessions", () => {
  const body = functionBody("get_order_payment_status_for_session");
  const orderLock = body.indexOf("from public.orders");
  const sessionLock = body.indexOf("from public.order_payment_sessions");

  assert.ok(orderLock > -1, "status must lock orders");
  assert.ok(sessionLock > orderLock, "status must lock sessions after orders");
  assert.doesNotMatch(body, /use_count\s*=\s*use_count\s*\+\s*1/);
  assert.doesNotMatch(body, /expires_at\s*=/);
  assert.match(body, /set status = 'expired'/);
  assert.match(body, /token_hash = normalized_token_hash/);
});

test("status RPC selects payment attempts deterministically and checks coherence", () => {
  const body = functionBody("get_order_payment_status_for_session");

  assert.match(body, /order by\s*case[\s\S]*order_record\.status = 'paid' and payment_attempts\.status = 'paid' then 0/);
  assert.match(body, /payment_attempts\.created_at desc,\s*payment_attempts\.id desc/);
  assert.match(body, /latest_attempt\.amount_cents <> order_record\.total_amount_cents/);
  assert.match(body, /latest_attempt\.status = 'paid'[\s\S]*order_record\.status <> 'paid'/);
  assert.doesNotMatch(body, /order_record\.status = 'paid'[\s\S]*contradictory_attempts\.status in \('created', 'processing'\)/);
  assert.match(body, /order_record\.status <> 'paid'[\s\S]*contradictory_attempts\.status = 'paid'/);
});

test("status RPC allows only 24h minimal recovery for expired sessions", () => {
  const body = functionBody("get_order_payment_status_for_session");

  assert.match(body, /recovery_deadline := locked_session\.created_at \+ interval '24 hours'/);
  assert.match(body, /locked_session\.status = 'expired' and now\(\) <= recovery_deadline/);
  assert.match(body, /status_recovered_after_expiration', locked_session\.status = 'expired'/);
  assert.match(body, /locked_session\.status not in \('active', 'expired'\)/);
  assert.doesNotMatch(body, /set\s+status\s*=\s*'active'/);
});

test("3DS sanitized payload uses explicit allowlist and service_role-only grants", () => {
  const markBody = functionBody("mark_kafka_payment_attempt_requires_3ds");

  assert.match(markBody, /jsonb_object_keys\(p_sanitized_payload\)/);
  assert.match(markBody, /not in \('culqi_status', 'object', 'requires_3ds'\)/);
  assert.match(markBody, /\(p_sanitized_payload ->> 'object'\) not in \('charge'\)/);
  assert.match(markBody, /jsonb_build_object\(\s*'culqi_status', 201,\s*'object', 'charge',\s*'requires_3ds', true/s);
  assert.doesNotMatch(markBody, /_test_\|/);
  assert.match(sql, /revoke all on function public\.mark_kafka_payment_attempt_requires_3ds[\s\S]*from public, anon, authenticated;/i);
  assert.match(sql, /grant execute on function public\.claim_kafka_payment_attempt_3ds_completion[\s\S]*to service_role;/i);
  assert.match(sql, /grant execute on function public\.get_order_payment_status_for_session[\s\S]*to service_role;/i);
});
