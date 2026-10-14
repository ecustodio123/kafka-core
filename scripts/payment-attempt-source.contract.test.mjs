import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const sql = read("../supabase/migrations/202610130012_validate_payment_attempt_source.sql");
const reserve = read("../supabase/migrations/202610130006_reserve_payment_attempts.sql");

test("source validator preserves the exact reserve fingerprint algorithm", () => {
  const expression = (text) => text.match(/request_fingerprint :=[\s\S]*?\n  \);/)[0];
  const expected = expression(reserve)
    .replaceAll("p_order_id", "attempt_record.order_id")
    .replaceAll("locked_order.", "attempt_record.");
  assert.equal(expression(sql), expected);
});

test("source validator has no writes or locks and returns only boolean", () => {
  const body = sql.split("as $$")[1].split("$$;")[0]
    .replace(/--[^\n]*/g, "");
  assert.doesNotMatch(body, /\b(insert|update|delete|perform|execute|for share)\b/i);
  assert.match(sql, /returns boolean[\s\S]*stable[\s\S]*security definer[\s\S]*set search_path = ''/i);
  assert.match(sql, /from public, anon, authenticated;/);
  assert.match(sql, /to service_role;/);
});
