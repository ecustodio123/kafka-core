-- Review after 015. Definition changes only; no existing payment rows are changed.
-- Session authorization and the exclusive claim commit/roll back together.
create or replace function public.kafka_claim_for_payment_session(
  p_store_id bigint,
  p_order_id uuid,
  p_payment_attempt_id uuid,
  p_token_hash text,
  p_idempotency_key text,
  p_culqi_source_id text,
  p_three_ds boolean,
  p_device_fingerprint_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  locked_order public.orders%rowtype;
  locked_attempt public.payment_attempts%rowtype;
  locked_session public.order_payment_sessions%rowtype;
  normalized_hash text := lower(btrim(coalesce(p_token_hash, '')));
  normalized_key text := btrim(coalesce(p_idempotency_key, ''));
  normalized_source text := btrim(coalesce(p_culqi_source_id, ''));
  normalized_device text := btrim(coalesce(p_device_fingerprint_id, ''));
  request_fingerprint text;
  checked_at timestamptz;
  result jsonb;
begin
  if p_store_id is null or p_store_id <= 0 or p_order_id is null
    or p_payment_attempt_id is null or p_three_ds is null
    or normalized_hash !~ '^[a-f0-9]{64}$'
  then
    return jsonb_build_object('authorized', false, 'acquired', false, 'reason', 'invalid_session');
  end if;

  -- Every payment writer locks this order first. Never acquire a reservation
  -- advisory lock or call reserve after locking attempts here.
  select * into locked_order from public.orders
  where orders.store_id = p_store_id and orders.id = p_order_id
  for update;
  if not found then
    return jsonb_build_object('authorized', false, 'acquired', false, 'reason', 'invalid_session');
  end if;

  select * into locked_attempt from public.payment_attempts
  where payment_attempts.store_id = p_store_id
    and payment_attempts.order_id = p_order_id
    and payment_attempts.id = p_payment_attempt_id
  for update;
  if not found then
    return jsonb_build_object('authorized', false, 'acquired', false, 'reason', 'invalid_session');
  end if;

  select * into locked_session from public.order_payment_sessions
  where order_payment_sessions.store_id = p_store_id
    and order_payment_sessions.order_id = p_order_id
    and order_payment_sessions.token_hash = normalized_hash
  for update;
  if not found then
    return jsonb_build_object('authorized', false, 'acquired', false, 'reason', 'invalid_session');
  end if;

  checked_at := clock_timestamp();
  if locked_session.status <> 'active' or locked_session.revoked_at is not null
    or locked_session.expires_at <= checked_at then
    -- No expiry/usage mutation: denied authorization must have no side effects.
    return jsonb_build_object('authorized', false, 'acquired', false, 'reason', 'invalid_session');
  end if;

  if locked_attempt.provider <> 'culqi' or locked_attempt.environment <> 'test'
    or locked_order.currency <> 'PEN' or locked_attempt.currency <> 'PEN'
    or locked_attempt.amount_cents <= 0
    or locked_attempt.amount_cents <> locked_order.total_amount_cents then
    raise exception 'intento de pago inconsistente con la orden';
  end if;

  if length(normalized_source) > 120 or normalized_source !~ '^(tkn|ype|crd)_test_[A-Za-z0-9]+$'
    or (not p_three_ds and (length(normalized_key) = 0 or length(normalized_key) > 120
      or normalized_key is distinct from locked_attempt.idempotency_key)) then
    raise exception 'payment idempotency key conflict';
  end if;

  -- Identical JSONB fingerprint algorithm to reserve_kafka_payment_attempt (006).
  -- A 3DS continuation uses the attempt's original key, never creates a new key.
  request_fingerprint := pg_catalog.encode(extensions.digest(jsonb_build_object(
    'store_id', p_store_id,
    'order_id', p_order_id,
    'environment', 'test',
    'amount_cents', locked_order.total_amount_cents,
    'currency', locked_order.currency,
    'culqi_source_id_sha256', pg_catalog.encode(extensions.digest(normalized_source, 'sha256'), 'hex')
  )::text, 'sha256'), 'hex');
  if locked_attempt.idempotency_fingerprint is distinct from request_fingerprint then
    raise exception 'payment idempotency key conflict';
  end if;

  if p_three_ds then
    if normalized_device !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      or locked_attempt.three_ds_device_fingerprint_hash is distinct from
        pg_catalog.encode(extensions.digest(normalized_device, 'sha256'), 'hex') then
      raise exception 'intento 3DS invalido';
    end if;
  end if;

  -- Preserve duplicate/terminal behavior. Reconciliation blocks only a NEW claim;
  -- a previous 3DS claim itself legitimately set reconciliation_required=true.
  if locked_attempt.status in ('paid', 'failed', 'expired', 'cancelled')
    or locked_attempt.status = 'processing' and not p_three_ds
    or p_three_ds and locked_attempt.three_ds_status = 'completion_processing'
    or locked_order.status = 'paid' then
    if p_three_ds then
      result := public.claim_kafka_payment_attempt_3ds_completion(p_store_id, p_payment_attempt_id, normalized_device);
    else
      result := public.claim_kafka_payment_attempt_processing(p_store_id, p_payment_attempt_id);
    end if;
    return result || jsonb_build_object('authorized', true);
  end if;

  if locked_order.status <> 'pending_payment'
    or (not p_three_ds and locked_attempt.status <> 'created')
    or (p_three_ds and (locked_attempt.status <> 'processing'
      or not locked_attempt.requires_3ds or locked_attempt.three_ds_status is distinct from 'required')) then
    raise exception 'transicion de intento de pago invalida';
  end if;

  if locked_attempt.reconciliation_required then
    return jsonb_build_object('authorized', true, 'acquired', false,
      'reason', 'reconciliation_required',
      'payment_attempt', public.kafka_payment_attempt_response(locked_attempt.id));
  end if;

  if p_three_ds then
    result := public.claim_kafka_payment_attempt_3ds_completion(p_store_id, p_payment_attempt_id, normalized_device);
  else
    result := public.claim_kafka_payment_attempt_processing(p_store_id, p_payment_attempt_id);
  end if;
  return result || jsonb_build_object('authorized', true);
end;
$$;

-- Internal helper: only the SECURITY DEFINER entry points may invoke it.
revoke all on function public.kafka_claim_for_payment_session(bigint, uuid, uuid, text, text, text, boolean, text)
from public, anon, authenticated, service_role;

create or replace function public.claim_payment_attempt_for_session(
  p_store_id bigint, p_order_id uuid, p_payment_attempt_id uuid,
  p_token_hash text, p_idempotency_key text, p_culqi_source_id text
)
returns jsonb language sql security definer set search_path = ''
as $$
  select public.kafka_claim_for_payment_session(p_store_id, p_order_id, p_payment_attempt_id,
    p_token_hash, p_idempotency_key, p_culqi_source_id, false, null);
$$;

create or replace function public.claim_payment_3ds_for_session(
  p_store_id bigint, p_order_id uuid, p_payment_attempt_id uuid,
  p_token_hash text, p_culqi_source_id text, p_device_fingerprint_id text
)
returns jsonb language sql security definer set search_path = ''
as $$
  select public.kafka_claim_for_payment_session(p_store_id, p_order_id, p_payment_attempt_id,
    p_token_hash, null, p_culqi_source_id, true, p_device_fingerprint_id);
$$;

revoke all on function public.claim_payment_attempt_for_session(bigint, uuid, uuid, text, text, text)
from public, anon, authenticated;
revoke all on function public.claim_payment_3ds_for_session(bigint, uuid, uuid, text, text, text)
from public, anon, authenticated;
grant execute on function public.claim_payment_attempt_for_session(bigint, uuid, uuid, text, text, text)
to service_role;
grant execute on function public.claim_payment_3ds_for_session(bigint, uuid, uuid, text, text, text)
to service_role;

create or replace function public.revoke_order_payment_sessions(p_store_id bigint, p_order_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  locked_order public.orders%rowtype;
  revoked_count integer;
begin
  if p_store_id is null or p_store_id <= 0 or p_order_id is null then
    raise exception 'sesion de pago invalida';
  end if;
  select * into locked_order from public.orders
  where orders.store_id = p_store_id and orders.id = p_order_id for update;
  if not found then raise exception 'sesion de pago invalida'; end if;

  update public.order_payment_sessions
  set status = 'revoked', revoked_at = clock_timestamp(), last_used_at = clock_timestamp()
  where order_payment_sessions.store_id = p_store_id and order_payment_sessions.order_id = p_order_id
    and (order_payment_sessions.status = 'active'
      or (order_payment_sessions.status = 'expired'
        and order_payment_sessions.created_at + interval '24 hours' >= clock_timestamp()));
  get diagnostics revoked_count = row_count;
  return jsonb_build_object('revoked_count', revoked_count);
end;
$$;
revoke all on function public.revoke_order_payment_sessions(bigint, uuid) from public, anon, authenticated;
grant execute on function public.revoke_order_payment_sessions(bigint, uuid) to service_role;

-- A revocation committed AFTER a successful claim cannot cancel an in-flight POST.
-- Never reset a claim or automatically retry provider work after an ambiguous result.
