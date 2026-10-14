-- Kafka Payments: read-only validation of the original Culqi TEST source.
-- Review and apply manually after migration 011. No existing data is changed.
create or replace function public.validate_payment_attempt_source(
  p_store_id bigint,
  p_payment_attempt_id uuid,
  p_culqi_source_id text
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  normalized_source_id text;
  request_fingerprint text;
  attempt_record record;
begin
  normalized_source_id := btrim(coalesce(p_culqi_source_id, ''));

  if p_store_id is null or p_store_id <= 0
    or p_payment_attempt_id is null
    or length(normalized_source_id) > 120
    or normalized_source_id !~ '^(tkn|ype|crd)_test_[A-Za-z0-9]+$'
  then
    raise exception 'validacion de intento de pago invalida';
  end if;

  -- One statement snapshot; no row/advisory locks or writes. Claim remains
  -- responsible for checking the current state and acquiring exclusive execution.
  select attempts.order_id, attempts.idempotency_fingerprint,
    orders.total_amount_cents, orders.currency
  into attempt_record
  from public.payment_attempts as attempts
  join public.orders
    on orders.id = attempts.order_id
    and orders.store_id = attempts.store_id
  join public.stores
    on stores.id = orders.store_id
  where attempts.id = p_payment_attempt_id
    and attempts.store_id = p_store_id
    and attempts.provider = 'culqi'
    and attempts.environment = 'test'
    and attempts.status = 'processing'
    and attempts.requires_3ds = true
    and attempts.three_ds_status in ('required', 'completion_processing')
    and orders.status = 'pending_payment'
    and orders.currency = 'PEN'
    and orders.total_amount_cents > 0
    and attempts.amount_cents = orders.total_amount_cents
    and attempts.currency = orders.currency;

  if not found then
    raise exception 'validacion de intento de pago invalida';
  end if;

  -- Keep identical to reserve_kafka_payment_attempt (006), including jsonb::text
  -- serialization, order amounts and the nested SHA-256 of the trimmed source.
  request_fingerprint := pg_catalog.encode(
    extensions.digest(
      jsonb_build_object(
        'store_id', p_store_id,
        'order_id', attempt_record.order_id,
        'environment', 'test',
        'amount_cents', attempt_record.total_amount_cents,
        'currency', attempt_record.currency,
        'culqi_source_id_sha256', pg_catalog.encode(
          extensions.digest(normalized_source_id, 'sha256'),
          'hex'
        )
      )::text,
      'sha256'
    ),
    'hex'
  );

  if attempt_record.idempotency_fingerprint is distinct from request_fingerprint then
    raise exception 'validacion de intento de pago invalida';
  end if;

  return true;
end;
$$;

revoke all on function public.validate_payment_attempt_source(bigint, uuid, text)
from public, anon, authenticated;

grant execute on function public.validate_payment_attempt_source(bigint, uuid, text)
to service_role;

-- This validates one snapshot, not authorization to send a charge. The Edge
-- Function must still acquire claim_kafka_payment_attempt_3ds_completion and
-- send only if acquired IS TRUE. No source or fingerprint is returned.
