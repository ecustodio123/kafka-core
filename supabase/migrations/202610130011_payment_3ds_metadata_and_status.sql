-- Kafka Payments v1 Fase 3D.3.3.3.3: 3DS metadata and safe order payment status.
-- Review and apply manually after 202610130010_validate_session_and_reserve_payment_attempt.sql.
-- This migration does not call Culqi and does not modify existing payment states.

create extension if not exists pgcrypto with schema extensions;

alter table public.payment_attempts
add column if not exists requires_3ds boolean not null default false,
add column if not exists three_ds_status text null,
add column if not exists three_ds_device_fingerprint_hash text null,
add column if not exists three_ds_claimed_at timestamptz null,
add column if not exists three_ds_completed_at timestamptz null,
add column if not exists reconciliation_required boolean not null default false,
add column if not exists reconciliation_reason text null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'payment_attempts_three_ds_status_check'
      and conrelid = 'public.payment_attempts'::regclass
  ) then
    alter table public.payment_attempts
    add constraint payment_attempts_three_ds_status_check
    check (
      three_ds_status is null
      or three_ds_status in (
        'required',
        'completion_processing',
        'completed',
        'failed'
      )
    );
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'payment_attempts_three_ds_fingerprint_hash_format'
      and conrelid = 'public.payment_attempts'::regclass
  ) then
    alter table public.payment_attempts
    add constraint payment_attempts_three_ds_fingerprint_hash_format
    check (
      three_ds_device_fingerprint_hash is null
      or three_ds_device_fingerprint_hash ~ '^[a-f0-9]{64}$'
    );
  end if;
end $$;

create index if not exists payment_attempts_reconciliation_idx
on public.payment_attempts (store_id, environment, status, reconciliation_required, updated_at desc)
where status = 'processing' or reconciliation_required = true;

create index if not exists payment_attempts_three_ds_pending_idx
on public.payment_attempts (store_id, order_id, environment, three_ds_status, updated_at desc)
where requires_3ds = true;

create or replace function public.mark_kafka_payment_attempt_requires_3ds(
  p_store_id bigint,
  p_payment_attempt_id uuid,
  p_device_fingerprint_id text,
  p_provider_reference text default null,
  p_sanitized_payload jsonb default null
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
  normalized_device_fingerprint_id text;
  normalized_provider_reference text;
  device_fingerprint_hash text;
  status_before text;
begin
  if p_store_id is null or p_store_id <= 0 then
    raise exception 'tienda invalida';
  end if;

  if p_payment_attempt_id is null then
    raise exception 'intento de pago invalido';
  end if;

  normalized_device_fingerprint_id := btrim(coalesce(p_device_fingerprint_id, ''));
  normalized_provider_reference := nullif(btrim(coalesce(p_provider_reference, '')), '');

  if normalized_device_fingerprint_id !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    raise exception 'device fingerprint invalido';
  end if;

  if normalized_provider_reference is not null and length(normalized_provider_reference) > 180 then
    raise exception 'provider_reference invalido';
  end if;

  if p_sanitized_payload is not null and (
    pg_catalog.jsonb_typeof(p_sanitized_payload) <> 'object'
    or exists (
      select 1
      from pg_catalog.jsonb_object_keys(p_sanitized_payload) as payload_keys(key)
      where payload_keys.key not in ('culqi_status', 'object', 'requires_3ds')
    )
    or (
      p_sanitized_payload ? 'culqi_status'
      and (
        pg_catalog.jsonb_typeof(p_sanitized_payload -> 'culqi_status') <> 'number'
        or (p_sanitized_payload -> 'culqi_status') <> '201'::jsonb
      )
    )
    or (
      p_sanitized_payload ? 'object'
      and (
        pg_catalog.jsonb_typeof(p_sanitized_payload -> 'object') <> 'string'
        or (p_sanitized_payload ->> 'object') not in ('charge')
      )
    )
    or (
      p_sanitized_payload ? 'requires_3ds'
      and (
        pg_catalog.jsonb_typeof(p_sanitized_payload -> 'requires_3ds') <> 'boolean'
        or (p_sanitized_payload -> 'requires_3ds') <> 'true'::jsonb
      )
    )
  ) then
    raise exception 'payload sanitizado invalido';
  end if;

  device_fingerprint_hash := pg_catalog.encode(
    extensions.digest(normalized_device_fingerprint_id, 'sha256'),
    'hex'
  );

  select payment_attempts.order_id
  into attempt_order_id
  from public.payment_attempts
  where payment_attempts.store_id = p_store_id
    and payment_attempts.id = p_payment_attempt_id;

  if not found then
    raise exception 'intento de pago invalido';
  end if;

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

  if locked_order.status <> 'pending_payment'
    or locked_attempt.status <> 'processing'
    or locked_attempt.environment <> 'test'
    or locked_attempt.provider <> 'culqi'
    or locked_attempt.amount_cents <> locked_order.total_amount_cents
    or locked_attempt.currency <> locked_order.currency
  then
    raise exception 'intento de pago inconsistente con la orden';
  end if;

  if locked_attempt.requires_3ds = true
    and locked_attempt.three_ds_status = 'required'
    and locked_attempt.three_ds_device_fingerprint_hash is not distinct from device_fingerprint_hash
    and (
      normalized_provider_reference is null
      or locked_attempt.provider_reference is not distinct from normalized_provider_reference
    )
  then
    return public.kafka_payment_attempt_response(locked_attempt.id)
      || jsonb_build_object(
        'requires_3ds', locked_attempt.requires_3ds,
        'three_ds_status', locked_attempt.three_ds_status,
        'reconciliation_required', locked_attempt.reconciliation_required
      );
  end if;

  if locked_attempt.requires_3ds = true
    or locked_attempt.three_ds_status is not null
    or locked_attempt.three_ds_device_fingerprint_hash is not null
  then
    raise exception 'intento 3DS invalido';
  end if;

  status_before := locked_attempt.status::text;

  update public.payment_attempts
  set requires_3ds = true,
      three_ds_status = 'required',
      three_ds_device_fingerprint_hash = device_fingerprint_hash,
      provider_reference = coalesce(normalized_provider_reference, provider_reference),
      reconciliation_required = false,
      reconciliation_reason = null,
      updated_at = now()
  where payment_attempts.id = locked_attempt.id
  returning *
  into locked_attempt;

  insert into public.payment_events (
    payment_attempt_id,
    order_id,
    store_id,
    provider,
    environment,
    event_type,
    provider_reference,
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
    'provider_response',
    normalized_provider_reference,
    status_before,
    locked_attempt.status::text,
    coalesce(
      p_sanitized_payload,
      jsonb_build_object(
        'culqi_status', 201,
        'object', 'charge',
        'requires_3ds', true
      )
    )
  );

  return public.kafka_payment_attempt_response(locked_attempt.id)
    || jsonb_build_object(
      'requires_3ds', locked_attempt.requires_3ds,
      'three_ds_status', locked_attempt.three_ds_status,
      'reconciliation_required', locked_attempt.reconciliation_required
    );
end;
$$;

create or replace function public.claim_kafka_payment_attempt_3ds_completion(
  p_store_id bigint,
  p_payment_attempt_id uuid,
  p_device_fingerprint_id text
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
  normalized_device_fingerprint_id text;
  device_fingerprint_hash text;
  three_ds_status_before text;
begin
  if p_store_id is null or p_store_id <= 0 then
    raise exception 'tienda invalida';
  end if;

  if p_payment_attempt_id is null then
    raise exception 'intento de pago invalido';
  end if;

  normalized_device_fingerprint_id := btrim(coalesce(p_device_fingerprint_id, ''));

  if normalized_device_fingerprint_id !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    raise exception 'device fingerprint invalido';
  end if;

  device_fingerprint_hash := pg_catalog.encode(
    extensions.digest(normalized_device_fingerprint_id, 'sha256'),
    'hex'
  );

  select payment_attempts.order_id
  into attempt_order_id
  from public.payment_attempts
  where payment_attempts.store_id = p_store_id
    and payment_attempts.id = p_payment_attempt_id;

  if not found then
    raise exception 'intento de pago invalido';
  end if;

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

  if locked_attempt.status in ('paid', 'failed', 'expired', 'cancelled')
    or locked_order.status = 'paid'
  then
    return jsonb_build_object(
      'acquired', false,
      'reason', 'terminal_state',
      'payment_attempt', public.kafka_payment_attempt_response(locked_attempt.id)
        || jsonb_build_object(
          'requires_3ds', locked_attempt.requires_3ds,
          'three_ds_status', locked_attempt.three_ds_status,
          'reconciliation_required', locked_attempt.reconciliation_required
        )
    );
  end if;

  if locked_order.status <> 'pending_payment'
    or locked_attempt.status <> 'processing'
    or locked_attempt.requires_3ds <> true
    or locked_attempt.three_ds_status is distinct from 'required'
    or locked_attempt.three_ds_device_fingerprint_hash is distinct from device_fingerprint_hash
  then
    if locked_attempt.three_ds_status = 'completion_processing' then
      return jsonb_build_object(
        'acquired', false,
        'reason', 'already_processing',
        'payment_attempt', public.kafka_payment_attempt_response(locked_attempt.id)
          || jsonb_build_object(
            'requires_3ds', locked_attempt.requires_3ds,
            'three_ds_status', locked_attempt.three_ds_status,
            'reconciliation_required', true
          )
      );
    end if;

    raise exception 'intento 3DS invalido';
  end if;

  three_ds_status_before := locked_attempt.three_ds_status;

  update public.payment_attempts
  set three_ds_status = 'completion_processing',
      three_ds_claimed_at = now(),
      reconciliation_required = true,
      reconciliation_reason = '3ds_completion_processing',
      updated_at = now()
  where payment_attempts.id = locked_attempt.id
    and payment_attempts.three_ds_status = 'required'
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
    locked_attempt.status::text,
    locked_attempt.status::text,
    jsonb_build_object(
      'action', 'claim_3ds_completion',
      'three_ds_status_before', three_ds_status_before,
      'three_ds_status_after', locked_attempt.three_ds_status
    )
  );

  return jsonb_build_object(
    'acquired', true,
    'reason', 'claimed',
    'payment_attempt', public.kafka_payment_attempt_response(locked_attempt.id)
      || jsonb_build_object(
        'requires_3ds', locked_attempt.requires_3ds,
        'three_ds_status', locked_attempt.three_ds_status,
        'reconciliation_required', locked_attempt.reconciliation_required
      )
  );
end;
$$;

create or replace function public.get_order_payment_status_for_session(
  p_store_id bigint,
  p_order_id uuid,
  p_token_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized_token_hash text;
  locked_session public.order_payment_sessions%rowtype;
  order_record public.orders%rowtype;
  latest_attempt public.payment_attempts%rowtype;
  recovery_deadline timestamptz;
begin
  if p_store_id is null or p_store_id <= 0 or p_order_id is null then
    raise exception 'sesion de pago invalida';
  end if;

  normalized_token_hash := lower(btrim(coalesce(p_token_hash, '')));

  if normalized_token_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'sesion de pago invalida';
  end if;

  select *
  into order_record
  from public.orders
  where orders.store_id = p_store_id
    and orders.id = p_order_id
  for update;

  if not found then
    return jsonb_build_object('valid', false, 'reason', 'invalid');
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

  if locked_session.expires_at <= now() and locked_session.status = 'active' then
    update public.order_payment_sessions
    set status = 'expired',
        last_used_at = now()
    where order_payment_sessions.id = locked_session.id
    returning *
    into locked_session;
  end if;

  if locked_session.status <> 'active' then
    recovery_deadline := locked_session.created_at + interval '24 hours';

    if locked_session.status = 'expired' and now() <= recovery_deadline then
      -- Expired sessions may only recover minimal status for the same token,
      -- store and order. They are not reactivated, consumed or extended here.
      null;
    else
      return jsonb_build_object(
        'valid', false,
        'reason', locked_session.status
      );
    end if;
  end if;

  if locked_session.status = 'active' then
    recovery_deadline := null;
  end if;

  if locked_session.status not in ('active', 'expired') then
    return jsonb_build_object(
      'valid', false,
      'reason', locked_session.status
    );
  end if;

  select *
  into latest_attempt
  from public.payment_attempts
  where payment_attempts.store_id = p_store_id
    and payment_attempts.order_id = p_order_id
    and payment_attempts.environment = 'test'
  order by
    case
      when order_record.status = 'paid' and payment_attempts.status = 'paid' then 0
      when order_record.status <> 'paid' then 0
      else 1
    end,
    payment_attempts.created_at desc,
    payment_attempts.id desc
  limit 1;

  if latest_attempt.id is not null and (
    latest_attempt.amount_cents <> order_record.total_amount_cents
    or latest_attempt.currency <> order_record.currency
    or (
      order_record.status = 'paid'
      and latest_attempt.status <> 'paid'
    )
    or (
      latest_attempt.status = 'paid'
      and order_record.status <> 'paid'
    )
    or (
      order_record.status <> 'paid'
      and exists (
        select 1
        from public.payment_attempts as contradictory_attempts
        where contradictory_attempts.store_id = p_store_id
          and contradictory_attempts.order_id = p_order_id
          and contradictory_attempts.environment = 'test'
          and contradictory_attempts.status = 'paid'
      )
    )
  ) then
    raise exception 'estado de pago inconsistente';
  end if;

  return jsonb_build_object(
    'valid', true,
    'store_id', order_record.store_id,
    'order_id', order_record.id,
    'order_status', order_record.status,
    'currency', order_record.currency,
    'total_amount_cents', order_record.total_amount_cents,
    'paid_at', order_record.paid_at,
    'status_recovered_after_expiration', locked_session.status = 'expired',
    'payment_attempt', case
      when latest_attempt.id is null then null
      else jsonb_build_object(
        'id', latest_attempt.id,
        'status', latest_attempt.status,
        'requires_3ds', latest_attempt.requires_3ds,
        'three_ds_status', latest_attempt.three_ds_status,
        'requires_reconciliation',
          latest_attempt.reconciliation_required
          or (
            latest_attempt.status = 'processing'
            and coalesce(latest_attempt.requires_3ds, false) = false
          )
          or (
            latest_attempt.three_ds_status is not distinct from 'completion_processing'
          ),
        'failure_code', latest_attempt.failure_code,
        'updated_at', latest_attempt.updated_at
      )
    end
  );
end;
$$;

revoke all on function public.mark_kafka_payment_attempt_requires_3ds(
  bigint,
  uuid,
  text,
  text,
  jsonb
) from public, anon, authenticated;

revoke all on function public.claim_kafka_payment_attempt_3ds_completion(
  bigint,
  uuid,
  text
) from public, anon, authenticated;

revoke all on function public.get_order_payment_status_for_session(
  bigint,
  uuid,
  text
) from public, anon, authenticated;

grant execute on function public.mark_kafka_payment_attempt_requires_3ds(
  bigint,
  uuid,
  text,
  text,
  jsonb
) to service_role;

grant execute on function public.claim_kafka_payment_attempt_3ds_completion(
  bigint,
  uuid,
  text
) to service_role;

grant execute on function public.get_order_payment_status_for_session(
  bigint,
  uuid,
  text
) to service_role;

-- The original device_finger_print_id is not stored. The checkout must keep it
-- client-side for the future 3DS continuation and the backend verifies it by
-- comparing its SHA-256 hash.
