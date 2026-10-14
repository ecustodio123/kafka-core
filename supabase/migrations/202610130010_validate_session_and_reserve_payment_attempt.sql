-- Kafka Payments v1 Fase 3C.2: validate payment session and reserve attempt atomically.
-- Review and apply manually after 202610130009_order_payment_sessions.sql.
-- This migration adds one RPC only. It does not call Culqi and does not modify
-- existing orders, sessions or payment attempts when applied.

create or replace function public.validate_order_payment_session_and_reserve_attempt(
  p_store_id bigint,
  p_order_id uuid,
  p_token_hash text,
  p_idempotency_key text,
  p_culqi_source_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized_token_hash text;
  normalized_idempotency_key text;
  normalized_source_id text;
  locked_order public.orders%rowtype;
  refreshed_order public.orders%rowtype;
  locked_session public.order_payment_sessions%rowtype;
  existing_attempt_id uuid;
  reserved_attempt jsonb;
begin
  if p_store_id is null or p_store_id <= 0 then
    raise exception 'sesion de pago invalida';
  end if;

  if p_order_id is null then
    raise exception 'sesion de pago invalida';
  end if;

  normalized_token_hash := lower(btrim(coalesce(p_token_hash, '')));
  normalized_idempotency_key := btrim(coalesce(p_idempotency_key, ''));
  normalized_source_id := btrim(coalesce(p_culqi_source_id, ''));

  if normalized_token_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'sesion de pago invalida';
  end if;

  if length(normalized_idempotency_key) = 0 or length(normalized_idempotency_key) > 120 then
    raise exception 'idempotency key requerida';
  end if;

  if normalized_source_id !~ '^(tkn|ype|crd)_test_[A-Za-z0-9]+$' then
    raise exception 'source Culqi TEST invalido';
  end if;

  -- Keep the repository-wide lock order for payments: orders first. This makes
  -- validation, reservation, revocation, claim and finalization serialize on the
  -- same order row before touching sessions or attempts.
  select *
  into locked_order
  from public.orders
  where orders.store_id = p_store_id
    and orders.id = p_order_id
  for update;

  if not found then
    return jsonb_build_object('valid', false, 'reason', 'invalid');
  end if;

  if locked_order.status = 'paid' then
    raise exception 'orden ya pagada';
  end if;

  if locked_order.status not in ('pending_payment', 'payment_failed') then
    raise exception 'estado de orden invalido para pago';
  end if;

  if nullif(btrim(coalesce(locked_order.customer_email, '')), '') is null then
    raise exception 'email del comprador requerido para pago';
  end if;

  select *
  into locked_session
  from public.order_payment_sessions
  where order_payment_sessions.store_id = p_store_id
    and order_payment_sessions.order_id = p_order_id
    and order_payment_sessions.token_hash = normalized_token_hash
  for update;

  if not found then
    return jsonb_build_object('valid', false, 'reason', 'invalid');
  end if;

  if locked_session.status <> 'active' then
    return jsonb_build_object(
      'valid', false,
      'reason', locked_session.status,
      'store_id', locked_session.store_id,
      'order_id', locked_session.order_id,
      'expires_at', locked_session.expires_at
    );
  end if;

  if locked_session.expires_at <= now() then
    update public.order_payment_sessions
    set status = 'expired',
        last_used_at = now()
    where order_payment_sessions.id = locked_session.id
    returning *
    into locked_session;

    return jsonb_build_object(
      'valid', false,
      'reason', 'expired',
      'store_id', locked_session.store_id,
      'order_id', locked_session.order_id,
      'expires_at', locked_session.expires_at
    );
  end if;

  update public.order_payment_sessions
  set used_at = coalesce(used_at, now()),
      last_used_at = now(),
      use_count = use_count + 1
  where order_payment_sessions.id = locked_session.id
  returning *
  into locked_session;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_store_id::text || ':' || normalized_idempotency_key, 0)
  );

  select payment_attempts.id
  into existing_attempt_id
  from public.payment_attempts
  where payment_attempts.store_id = p_store_id
    and payment_attempts.idempotency_key = normalized_idempotency_key
  for update;

  reserved_attempt := public.reserve_kafka_payment_attempt(
    p_store_id,
    p_order_id,
    normalized_idempotency_key,
    normalized_source_id
  );

  select *
  into refreshed_order
  from public.orders
  where orders.store_id = p_store_id
    and orders.id = p_order_id;

  return jsonb_build_object(
    'valid', true,
    'existing_attempt', existing_attempt_id is not null,
    'payment_attempt', reserved_attempt,
    'order', jsonb_build_object(
      'id', refreshed_order.id,
      'store_id', refreshed_order.store_id,
      'customer_email', refreshed_order.customer_email,
      'whatsapp_message', refreshed_order.whatsapp_message,
      'status', refreshed_order.status,
      'total_amount_cents', refreshed_order.total_amount_cents,
      'currency', refreshed_order.currency
    ),
    'session', jsonb_build_object(
      'store_id', locked_session.store_id,
      'order_id', locked_session.order_id,
      'expires_at', locked_session.expires_at
    )
  );
end;
$$;

revoke all on function public.validate_order_payment_session_and_reserve_attempt(
  bigint,
  uuid,
  text,
  text,
  text
) from public, anon, authenticated;

grant execute on function public.validate_order_payment_session_and_reserve_attempt(
  bigint,
  uuid,
  text,
  text,
  text
) to service_role;

-- Revoking a session after this RPC commits prevents future reservations, but
-- does not cancel an already-reserved or processing payment attempt. In-flight
-- attempts remain blocked by claim/finalize/reconciliation semantics.
