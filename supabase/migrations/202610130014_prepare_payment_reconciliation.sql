-- Reconciliation infrastructure only. Review after 013; do not apply automatically.
-- No financial writes, new tables, enums, flags, provider calls or existing-row changes.

-- VOLATILE is intentional: an invocation after waiting for row locks must see
-- committed changes, not reuse the caller's earlier statement snapshot.
create or replace function public.get_kafka_payment_reconciliation_snapshot(
  p_store_id bigint,
  p_order_id uuid,
  p_payment_attempt_id uuid
)
returns jsonb
language sql
volatile
security definer
set search_path = ''
set timezone = 'UTC'
as $$
  select pg_catalog.jsonb_build_object(
    'store_id', a.store_id, 'order_id', o.id, 'payment_attempt_id', a.id,
    'order_status', o.status, 'attempt_status', a.status,
    'amount_cents', a.amount_cents, 'currency', a.currency,
    'environment', a.environment, 'culqi_charge_id', a.culqi_charge_id,
    'provider_reference', a.provider_reference,
    'snapshot_hash', pg_catalog.encode(extensions.digest(
      pg_catalog.jsonb_build_array(pg_catalog.to_jsonb(o), pg_catalog.to_jsonb(a))::text,
      'sha256'), 'hex'))
  from public.orders as o
  join public.payment_attempts as a on a.order_id = o.id and a.store_id = o.store_id
  join public.stores as s on s.id = o.store_id
  where o.store_id = p_store_id and o.id = p_order_id
    and a.id = p_payment_attempt_id and a.provider = 'culqi'
    and a.environment = 'test' and a.currency = 'PEN' and o.currency = 'PEN'
    and a.amount_cents > 0 and a.amount_cents = o.total_amount_cents;
$$;

create or replace function public.prepare_kafka_payment_reconciliation(
  p_store_id bigint,
  p_order_id uuid,
  p_payment_attempt_id uuid,
  p_idempotency_key uuid,
  p_expected_snapshot_hash text,
  p_evidence jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set timezone = 'UTC'
as $$
declare
  locked_order public.orders%rowtype;
  locked_attempt public.payment_attempts%rowtype;
  existing_event public.payment_events%rowtype;
  current_snapshot jsonb;
  metadata jsonb;
  charge_id text;
  event_key text;
  request_fingerprint text;
  receipt jsonb;
begin
  if p_store_id is null or p_store_id <= 0 or p_order_id is null
    or p_payment_attempt_id is null or p_idempotency_key is null
    or p_expected_snapshot_hash is null or length(p_expected_snapshot_hash) <> 64
    or p_expected_snapshot_hash !~ '^[a-f0-9]{64}$'
  then
    raise exception 'solicitud de reconciliacion invalida';
  end if;

  -- This is an identity-evidence schema, not raw Culqi JSON or a financial verdict.
  if p_evidence is null or pg_catalog.jsonb_typeof(p_evidence) <> 'object'
    or pg_catalog.length(p_evidence::text) > 4096 then
    raise exception 'evidencia de reconciliacion invalida';
  end if;
  if (p_evidence - array['schema_version','provider','environment','charge_id',
      'amount_cents','currency','metadata']::text[]) <> '{}'::jsonb
    or not (p_evidence ?& array['schema_version','provider','environment','charge_id',
      'amount_cents','currency','metadata']::text[])
    or p_evidence->'schema_version' is distinct from '1'::jsonb
    or p_evidence->'provider' is distinct from '"culqi"'::jsonb
    or p_evidence->'environment' is distinct from '"test"'::jsonb
    or p_evidence->'currency' is distinct from '"PEN"'::jsonb
    or pg_catalog.jsonb_typeof(p_evidence->'charge_id') is distinct from 'string'
    or pg_catalog.jsonb_typeof(p_evidence->'amount_cents') is distinct from 'number'
    or pg_catalog.jsonb_typeof(p_evidence->'metadata') is distinct from 'object'
  then
    raise exception 'evidencia de reconciliacion invalida';
  end if;
  charge_id := p_evidence->>'charge_id';
  metadata := p_evidence->'metadata';
  if length(charge_id) > 160 or charge_id !~ '^chr_test_[A-Za-z0-9]{1,151}$'
    or charge_id ~ '[^A-Za-z0-9_]'
    or metadata is distinct from pg_catalog.jsonb_build_object(
      'kafka_store_id', p_store_id::text, 'kafka_order_id', p_order_id::text,
      'kafka_payment_attempt_id', p_payment_attempt_id::text)
  then
    raise exception 'evidencia de reconciliacion invalida';
  end if;

  -- Same row-lock order as finalize (013) and both exclusive claims (008/011).
  -- Do not take an advisory lock, lock sessions, or hold locks across HTTP work.
  select * into locked_order from public.orders as o
  where o.store_id = p_store_id and o.id = p_order_id for update;
  if not found then raise exception 'recurso de reconciliacion invalido'; end if;
  select * into locked_attempt from public.payment_attempts as a
  where a.store_id = p_store_id and a.order_id = p_order_id
    and a.id = p_payment_attempt_id for update;
  if not found or not exists (select 1 from public.stores as s where s.id = p_store_id)
    or locked_attempt.provider <> 'culqi' or locked_attempt.environment <> 'test'
  then
    raise exception 'recurso de reconciliacion invalido';
  end if;

  event_key := 'kafka-reconcile-v1:' || p_idempotency_key::text;
  request_fingerprint := pg_catalog.encode(extensions.digest(
    pg_catalog.jsonb_build_object('store_id', p_store_id, 'order_id', p_order_id,
      'attempt_id', p_payment_attempt_id, 'snapshot', p_expected_snapshot_hash,
      'evidence', p_evidence)::text, 'sha256'), 'hex');

  select * into existing_event from public.payment_events as e
  where e.store_id = p_store_id and e.environment = 'test' and e.provider = 'culqi'
    and e.provider_event_id = event_key;
  if found then
    if existing_event.payment_attempt_id <> p_payment_attempt_id
      or existing_event.order_id <> p_order_id
      or existing_event.sanitized_payload->>'action' is distinct from 'prepare_reconciliation_v1'
      or existing_event.sanitized_payload->>'request_fingerprint' is distinct from request_fingerprint
    then raise exception 'clave de reconciliacion en conflicto'; end if;
    -- Historical receipt, not current financial state or renewed authorization.
    return existing_event.sanitized_payload->'receipt';
  end if;

  if locked_order.currency <> 'PEN' or locked_attempt.currency <> 'PEN'
    or locked_attempt.amount_cents <= 0
    or locked_attempt.amount_cents <> locked_order.total_amount_cents
    or p_evidence->'amount_cents' is distinct from pg_catalog.to_jsonb(locked_attempt.amount_cents)
  then raise exception 'importe de reconciliacion incompatible'; end if;

  -- Only persisted references can be candidates. No new reference is attached.
  if (locked_attempt.culqi_charge_id is null and locked_attempt.provider_reference is null)
    or (locked_attempt.culqi_charge_id is not null and locked_attempt.culqi_charge_id <> charge_id)
    or (locked_attempt.provider_reference is not null and locked_attempt.provider_reference <> charge_id)
  then raise exception 'referencia de reconciliacion incompatible'; end if;

  if locked_order.status in ('draft', 'whatsapp_only')
    or (locked_attempt.status = 'paid' and locked_order.status <> 'paid')
    or (locked_attempt.status in ('created','processing')
      and locked_order.status not in ('pending_payment','paid'))
    or (locked_order.status <> 'paid' and exists (
      select 1 from public.payment_attempts as a
      where a.store_id = p_store_id and a.order_id = p_order_id
        and a.environment = 'test' and a.status = 'paid'))
    or (locked_order.status = 'paid' and not exists (
      select 1 from public.payment_attempts as a
      where a.store_id = p_store_id and a.order_id = p_order_id
        and a.environment = 'test' and a.status = 'paid'
        and a.amount_cents = locked_order.total_amount_cents and a.currency = locked_order.currency))
  then raise exception 'estado de reconciliacion incompatible'; end if;

  current_snapshot := public.get_kafka_payment_reconciliation_snapshot(
    p_store_id, p_order_id, p_payment_attempt_id);
  if current_snapshot is null
    or current_snapshot->>'snapshot_hash' is distinct from p_expected_snapshot_hash
  then raise exception 'snapshot de reconciliacion obsoleto'; end if;

  receipt := pg_catalog.jsonb_build_object(
    'result', 'not_applied', 'reason', 'pending_provider_confirmation',
    'financial_transitions_enabled', false, 'financial_state_modified', false,
    'store_id', p_store_id, 'order_id', p_order_id,
    'payment_attempt_id', p_payment_attempt_id);

  -- The existing enum has no internal-preparation event. provider_response is
  -- retained for compatibility, NOT as a claim of verified provider evidence.
  -- Consumers must distinguish this internal action from financial confirmations.
  insert into public.payment_events (
    store_id, order_id, payment_attempt_id, provider, environment, event_type,
    provider_event_id, provider_reference, status_before, status_after, sanitized_payload
  ) values (
    p_store_id, p_order_id, p_payment_attempt_id, 'culqi', 'test', 'provider_response',
    event_key, charge_id, locked_attempt.status::text, locked_attempt.status::text,
    pg_catalog.jsonb_build_object('action', 'prepare_reconciliation_v1',
      'event_origin', 'internal_reconciliation_preparation',
      'financial_evidence_verified', false,
      'request_fingerprint', request_fingerprint, 'identity_evidence', p_evidence,
      'receipt', receipt)
  ) on conflict (store_id, environment, provider, provider_event_id) do nothing;

  -- Handles a reused key across different orders without locking their rows.
  -- The unique index serializes the inserts; no exception handler drops our locks.
  select * into existing_event from public.payment_events as e
  where e.store_id = p_store_id and e.environment = 'test' and e.provider = 'culqi'
    and e.provider_event_id = event_key;
  if not found or existing_event.payment_attempt_id <> p_payment_attempt_id
    or existing_event.order_id <> p_order_id
    or existing_event.sanitized_payload->>'action' is distinct from 'prepare_reconciliation_v1'
    or existing_event.sanitized_payload->>'request_fingerprint' is distinct from request_fingerprint
  then raise exception 'clave de reconciliacion en conflicto'; end if;
  return existing_event.sanitized_payload->'receipt';
end;
$$;

revoke all on function public.get_kafka_payment_reconciliation_snapshot(bigint, uuid, uuid)
from public, anon, authenticated;
grant execute on function public.get_kafka_payment_reconciliation_snapshot(bigint, uuid, uuid)
to service_role;
revoke all on function public.prepare_kafka_payment_reconciliation(bigint, uuid, uuid, uuid, text, jsonb)
from public, anon, authenticated;
grant execute on function public.prepare_kafka_payment_reconciliation(bigint, uuid, uuid, uuid, text, jsonb)
to service_role;
