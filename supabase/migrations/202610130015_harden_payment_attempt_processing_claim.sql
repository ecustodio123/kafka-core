-- Kafka Payments: block processing claims for attempts pending reconciliation.
-- Review and apply manually after 014. Replaces only the existing claim RPC.
-- No existing records are modified when this migration is applied.

create or replace function public.claim_kafka_payment_attempt_processing(
  p_store_id bigint,
  p_payment_attempt_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  attempt_order_id uuid;
  locked_order public.orders%rowtype;
  locked_attempt public.payment_attempts%rowtype;
  status_before text;
begin
  if p_store_id is null or p_store_id <= 0 then
    raise exception 'tienda invalida';
  end if;

  if p_payment_attempt_id is null then
    raise exception 'intento de pago invalido';
  end if;

  select payment_attempts.order_id
  into attempt_order_id
  from public.payment_attempts
  where payment_attempts.store_id = p_store_id
    and payment_attempts.id = p_payment_attempt_id;

  if not found then
    raise exception 'intento de pago invalido';
  end if;

  -- Keep the same lock order used by finalize_kafka_payment_attempt:
  -- orders first, then payment_attempts.
  select *
  into locked_order
  from public.orders
  where orders.store_id = p_store_id
    and orders.id = attempt_order_id
  for update;

  if not found then
    raise exception 'orden invalida';
  end if;

  select *
  into locked_attempt
  from public.payment_attempts
  where payment_attempts.store_id = p_store_id
    and payment_attempts.id = p_payment_attempt_id
  for update;

  if not found then
    raise exception 'intento de pago invalido';
  end if;

  if locked_attempt.environment <> 'test'
    or locked_attempt.provider <> 'culqi'
    or locked_attempt.amount_cents <> locked_order.total_amount_cents
    or locked_attempt.currency <> locked_order.currency
  then
    raise exception 'intento de pago inconsistente con la orden';
  end if;

  if locked_attempt.status = 'processing' then
    return jsonb_build_object(
      'acquired', false,
      'reason', 'already_processing',
      'payment_attempt', public.kafka_payment_attempt_response(locked_attempt.id)
    );
  end if;

  if locked_attempt.status in ('paid', 'failed', 'expired', 'cancelled') then
    return jsonb_build_object(
      'acquired', false,
      'reason', 'terminal_state',
      'payment_attempt', public.kafka_payment_attempt_response(locked_attempt.id)
    );
  end if;

  if locked_attempt.status <> 'created' then
    raise exception 'transicion de intento de pago invalida';
  end if;

  if locked_order.status <> 'pending_payment' then
    raise exception 'estado de orden invalido para procesar pago';
  end if;

  -- Check under both row locks; never revive an uncertain created reservation.
  if locked_attempt.reconciliation_required then
    return jsonb_build_object(
      'acquired', false,
      'reason', 'reconciliation_required',
      'payment_attempt', public.kafka_payment_attempt_response(locked_attempt.id)
    );
  end if;

  status_before := locked_attempt.status::text;

  update public.payment_attempts
  set status = 'processing',
      updated_at = now()
  where payment_attempts.id = locked_attempt.id
    and payment_attempts.status = 'created'
  returning *
  into locked_attempt;

  if not found then
    return jsonb_build_object(
      'acquired', false,
      'reason', 'lost_race',
      'payment_attempt', public.kafka_payment_attempt_response(p_payment_attempt_id)
    );
  end if;

  insert into public.payment_events (
    payment_attempt_id,
    order_id,
    store_id,
    provider,
    environment,
    event_type,
    status_before,
    status_after,
    sanitized_payload
  )
  values (
    locked_attempt.id,
    locked_attempt.order_id,
    locked_attempt.store_id,
    locked_attempt.provider,
    locked_attempt.environment,
    'status_changed',
    status_before,
    locked_attempt.status::text,
    jsonb_build_object('action', 'claim_payment_attempt_processing')
  );

  return jsonb_build_object(
    'acquired', true,
    'reason', 'claimed',
    'payment_attempt', public.kafka_payment_attempt_response(locked_attempt.id)
  );
end;
$$;

revoke all on function public.claim_kafka_payment_attempt_processing(bigint, uuid)
from public, anon, authenticated;

grant execute on function public.claim_kafka_payment_attempt_processing(bigint, uuid)
to service_role;

-- Only callers receiving acquired=true may initiate provider work.
