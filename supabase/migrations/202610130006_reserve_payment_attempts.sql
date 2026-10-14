-- Kafka Payments v1 Fase 3B: reserve and finalize payment attempts.
-- Review and apply manually after 202610130005_fix_culqi_settings_rpc.sql.
-- This migration does not call Culqi. It only prepares transactional payment
-- attempt reservation, processing transitions and finalization.

create extension if not exists pgcrypto with schema extensions;

alter table public.payment_attempts
add column if not exists idempotency_fingerprint text null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'payment_attempts_idempotency_fingerprint_format'
      and conrelid = 'public.payment_attempts'::regclass
  ) then
    alter table public.payment_attempts
    add constraint payment_attempts_idempotency_fingerprint_format
    check (
      idempotency_fingerprint is null
      or idempotency_fingerprint ~ '^[a-f0-9]{64}$'
    );
  end if;
end $$;

do $$
begin
  if exists (
    select 1
    from public.payment_attempts
    where status in ('created', 'processing')
    group by store_id, order_id, environment
    having count(*) > 1
  ) then
    raise exception 'existen multiples intentos activos para una misma orden; revisar antes de aplicar Fase 3B';
  end if;
end $$;

create unique index if not exists payment_attempts_one_uncertain_per_order_idx
on public.payment_attempts (store_id, order_id, environment)
where status in ('created', 'processing');

create index if not exists payment_attempts_store_order_environment_status_idx
on public.payment_attempts (store_id, order_id, environment, status);

create or replace function public.kafka_payment_attempt_response(
  p_payment_attempt_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', attempts.id,
    'order_id', attempts.order_id,
    'store_id', attempts.store_id,
    'provider', attempts.provider,
    'environment', attempts.environment,
    'status', attempts.status,
    'order_status', orders.status,
    'amount_cents', attempts.amount_cents,
    'currency', attempts.currency,
    'culqi_charge_id', attempts.culqi_charge_id,
    'failure_code', attempts.failure_code,
    'failure_message', attempts.failure_message,
    'provider_reference', attempts.provider_reference,
    'created_at', attempts.created_at,
    'updated_at', attempts.updated_at
  )
  from public.payment_attempts as attempts
  join public.orders
    on orders.store_id = attempts.store_id
    and orders.id = attempts.order_id
  where attempts.id = p_payment_attempt_id;
$$;

create or replace function public.reserve_kafka_payment_attempt(
  p_store_id bigint,
  p_order_id uuid,
  p_idempotency_key text,
  p_culqi_source_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  locked_order public.orders%rowtype;
  existing_attempt public.payment_attempts%rowtype;
  active_attempt public.payment_attempts%rowtype;
  inserted_attempt public.payment_attempts%rowtype;
  normalized_idempotency_key text;
  normalized_source_id text;
  request_fingerprint text;
begin
  if p_store_id is null or p_store_id <= 0 then
    raise exception 'tienda invalida';
  end if;

  if p_order_id is null then
    raise exception 'orden invalida';
  end if;

  normalized_idempotency_key := btrim(coalesce(p_idempotency_key, ''));
  normalized_source_id := btrim(coalesce(p_culqi_source_id, ''));

  if length(normalized_idempotency_key) = 0 or length(normalized_idempotency_key) > 120 then
    raise exception 'idempotency key requerida';
  end if;

  if normalized_source_id !~ '^(tkn|ype|crd)_test_[A-Za-z0-9]+$' then
    raise exception 'source Culqi TEST invalido';
  end if;

  if not exists (
    select 1
    from public.store_payment_settings as settings
    where settings.store_id = p_store_id
      and settings.provider = 'culqi'
      and settings.environment = 'test'
      and settings.active = true
      and settings.culqi_enabled = true
      and settings.currency = 'PEN'
      and settings.culqi_public_key is not null
      and settings.culqi_private_key_secret_id is not null
  ) then
    raise exception 'pagos Culqi TEST no configurados para la tienda';
  end if;

  select *
  into locked_order
  from public.orders
  where orders.store_id = p_store_id
    and orders.id = p_order_id
  for update;

  if not found then
    raise exception 'orden invalida';
  end if;

  if locked_order.status = 'paid' then
    raise exception 'orden ya pagada';
  end if;

  if locked_order.status not in ('pending_payment', 'payment_failed') then
    raise exception 'estado de orden invalido para pago';
  end if;

  if locked_order.currency <> 'PEN' or locked_order.total_amount_cents <= 0 then
    raise exception 'monto de orden invalido';
  end if;

  request_fingerprint := pg_catalog.encode(
    extensions.digest(
      jsonb_build_object(
        'store_id', p_store_id,
        'order_id', p_order_id,
        'environment', 'test',
        'amount_cents', locked_order.total_amount_cents,
        'currency', locked_order.currency,
        'culqi_source_id_sha256', pg_catalog.encode(
          extensions.digest(normalized_source_id, 'sha256'),
          'hex'
        )
      )::text,
      'sha256'
    ),
    'hex'
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_store_id::text || ':' || normalized_idempotency_key, 0)
  );

  select *
  into existing_attempt
  from public.payment_attempts
  where payment_attempts.store_id = p_store_id
    and payment_attempts.idempotency_key = normalized_idempotency_key
  for update;

  if found then
    if existing_attempt.idempotency_fingerprint is distinct from request_fingerprint then
      raise exception 'payment idempotency key conflict';
    end if;

    return public.kafka_payment_attempt_response(existing_attempt.id);
  end if;

  select *
  into active_attempt
  from public.payment_attempts
  where payment_attempts.store_id = p_store_id
    and payment_attempts.order_id = p_order_id
    and payment_attempts.environment = 'test'
    and payment_attempts.status in ('created', 'processing')
  order by payment_attempts.created_at desc
  limit 1
  for update;

  if found then
    raise exception 'la orden ya tiene un intento de pago pendiente';
  end if;

  if locked_order.status = 'payment_failed' then
    update public.orders
    set status = 'pending_payment',
        updated_at = now()
    where orders.store_id = locked_order.store_id
      and orders.id = locked_order.id;
  end if;

  insert into public.payment_attempts (
    order_id,
    store_id,
    provider,
    environment,
    status,
    amount_cents,
    currency,
    idempotency_key,
    idempotency_fingerprint
  )
  values (
    locked_order.id,
    locked_order.store_id,
    'culqi',
    'test',
    'created',
    locked_order.total_amount_cents,
    locked_order.currency,
    normalized_idempotency_key,
    request_fingerprint
  )
  returning *
  into inserted_attempt;

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
    inserted_attempt.id,
    inserted_attempt.order_id,
    inserted_attempt.store_id,
    inserted_attempt.provider,
    inserted_attempt.environment,
    'status_changed',
    null,
    inserted_attempt.status::text,
    jsonb_build_object('action', 'reserve_payment_attempt')
  );

  return public.kafka_payment_attempt_response(inserted_attempt.id);
exception
  when unique_violation then
    select *
    into existing_attempt
    from public.payment_attempts
    where payment_attempts.store_id = p_store_id
      and payment_attempts.idempotency_key = normalized_idempotency_key;

    if found then
      if existing_attempt.idempotency_fingerprint is distinct from request_fingerprint then
        raise exception 'payment idempotency key conflict';
      end if;

      return public.kafka_payment_attempt_response(existing_attempt.id);
    end if;

    raise;
end;
$$;

create or replace function public.mark_kafka_payment_attempt_processing(
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

  if locked_attempt.status = 'processing' then
    return public.kafka_payment_attempt_response(locked_attempt.id);
  end if;

  if locked_attempt.status <> 'created' then
    raise exception 'transicion de intento de pago invalida';
  end if;

  if locked_order.status <> 'pending_payment' then
    raise exception 'estado de orden invalido para procesar pago';
  end if;

  if locked_attempt.amount_cents <> locked_order.total_amount_cents
    or locked_attempt.currency <> locked_order.currency
    or locked_attempt.environment <> 'test'
  then
    raise exception 'intento de pago inconsistente con la orden';
  end if;

  status_before := locked_attempt.status::text;

  update public.payment_attempts
  set status = 'processing',
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
    jsonb_build_object('action', 'mark_payment_attempt_processing')
  );

  return public.kafka_payment_attempt_response(locked_attempt.id);
end;
$$;

create or replace function public.finalize_kafka_payment_attempt(
  p_store_id bigint,
  p_payment_attempt_id uuid,
  p_final_status public.kafka_payment_attempt_status,
  p_culqi_charge_id text default null,
  p_failure_code text default null,
  p_failure_message text default null,
  p_provider_event_id text default null,
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
  duplicate_event_attempt_id uuid;
  locked_order public.orders%rowtype;
  locked_attempt public.payment_attempts%rowtype;
  status_before text;
  normalized_charge_id text;
  normalized_failure_code text;
  normalized_failure_message text;
  normalized_provider_event_id text;
  normalized_provider_reference text;
begin
  if p_store_id is null or p_store_id <= 0 then
    raise exception 'tienda invalida';
  end if;

  if p_payment_attempt_id is null then
    raise exception 'intento de pago invalido';
  end if;

  if p_final_status not in ('paid', 'failed') then
    raise exception 'estado final invalido';
  end if;

  normalized_charge_id := nullif(btrim(coalesce(p_culqi_charge_id, '')), '');
  normalized_failure_code := nullif(btrim(coalesce(p_failure_code, '')), '');
  normalized_failure_message := nullif(btrim(coalesce(p_failure_message, '')), '');
  normalized_provider_event_id := nullif(btrim(coalesce(p_provider_event_id, '')), '');
  normalized_provider_reference := nullif(btrim(coalesce(p_provider_reference, '')), '');

  if normalized_charge_id is not null and length(normalized_charge_id) > 160 then
    raise exception 'culqi_charge_id invalido';
  end if;

  if normalized_failure_code is not null and length(normalized_failure_code) > 120 then
    raise exception 'failure_code invalido';
  end if;

  if normalized_failure_message is not null and length(normalized_failure_message) > 500 then
    raise exception 'failure_message invalido';
  end if;

  if normalized_provider_event_id is not null and length(normalized_provider_event_id) > 180 then
    raise exception 'provider_event_id invalido';
  end if;

  if normalized_provider_reference is not null and length(normalized_provider_reference) > 180 then
    raise exception 'provider_reference invalido';
  end if;

  if p_sanitized_payload is not null
    and (
      pg_catalog.length(p_sanitized_payload::text) > 20000
      or p_sanitized_payload::text ~ '(tkn|ype|crd|sk|pk)_test_'
      or p_sanitized_payload::text ~ '(tkn|ype|crd|sk|pk)_live_'
    )
  then
    raise exception 'payload sanitizado invalido';
  end if;

  if p_final_status = 'paid' and normalized_charge_id is null then
    raise exception 'culqi_charge_id requerido para pago aprobado';
  end if;

  if normalized_provider_event_id is not null then
    select payment_events.payment_attempt_id
    into duplicate_event_attempt_id
    from public.payment_events
    where payment_events.store_id = p_store_id
      and payment_events.environment = 'test'
      and payment_events.provider = 'culqi'
      and payment_events.provider_event_id = normalized_provider_event_id
    limit 1;

    if found then
      if duplicate_event_attempt_id <> p_payment_attempt_id then
        raise exception 'provider_event_id ya registrado para otro intento';
      end if;

      return public.kafka_payment_attempt_response(duplicate_event_attempt_id);
    end if;
  end if;

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

  if locked_attempt.environment <> 'test'
    or locked_attempt.provider <> 'culqi'
    or locked_attempt.amount_cents <> locked_order.total_amount_cents
    or locked_attempt.currency <> locked_order.currency
  then
    raise exception 'intento de pago inconsistente con la orden';
  end if;

  if locked_order.status = 'paid' then
    return public.kafka_payment_attempt_response(locked_attempt.id);
  end if;

  if locked_attempt.status = 'paid' then
    return public.kafka_payment_attempt_response(locked_attempt.id);
  end if;

  if locked_attempt.status = 'failed' then
    if p_final_status = 'failed' then
      return public.kafka_payment_attempt_response(locked_attempt.id);
    end if;

    raise exception 'intento de pago ya finalizado';
  end if;

  if locked_attempt.status <> 'processing' then
    raise exception 'transicion de intento de pago invalida';
  end if;

  if locked_order.status <> 'pending_payment' then
    raise exception 'estado de orden invalido para finalizar pago';
  end if;

  status_before := locked_attempt.status::text;

  if p_final_status = 'paid' then
    update public.payment_attempts
    set status = 'paid',
        culqi_charge_id = normalized_charge_id,
        provider_reference = coalesce(normalized_provider_reference, normalized_charge_id),
        failure_code = null,
        failure_message = null,
        updated_at = now()
    where payment_attempts.id = locked_attempt.id
    returning *
    into locked_attempt;

    update public.orders
    set status = 'paid',
        paid_at = coalesce(paid_at, now()),
        updated_at = now()
    where orders.store_id = locked_order.store_id
      and orders.id = locked_order.id;
  else
    update public.payment_attempts
    set status = 'failed',
        failure_code = normalized_failure_code,
        failure_message = normalized_failure_message,
        provider_reference = normalized_provider_reference,
        updated_at = now()
    where payment_attempts.id = locked_attempt.id
    returning *
    into locked_attempt;

    update public.orders
    set status = 'payment_failed',
        updated_at = now()
    where orders.store_id = locked_order.store_id
      and orders.id = locked_order.id
      and orders.status <> 'paid';
  end if;

  insert into public.payment_events (
    payment_attempt_id,
    order_id,
    store_id,
    provider,
    environment,
    event_type,
    provider_event_id,
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
    'status_changed',
    normalized_provider_event_id,
    coalesce(normalized_provider_reference, normalized_charge_id),
    status_before,
    locked_attempt.status::text,
    p_sanitized_payload
  );

  return public.kafka_payment_attempt_response(locked_attempt.id);
exception
  when unique_violation then
    if normalized_provider_event_id is not null then
      select payment_events.payment_attempt_id
      into duplicate_event_attempt_id
      from public.payment_events
      where payment_events.store_id = p_store_id
        and payment_events.environment = 'test'
        and payment_events.provider = 'culqi'
        and payment_events.provider_event_id = normalized_provider_event_id
      limit 1;

      if found and duplicate_event_attempt_id = p_payment_attempt_id then
        return public.kafka_payment_attempt_response(duplicate_event_attempt_id);
      end if;
    end if;

    raise;
end;
$$;

revoke all on function public.kafka_payment_attempt_response(uuid)
from public, anon, authenticated;

revoke all on function public.reserve_kafka_payment_attempt(
  bigint,
  uuid,
  text,
  text
) from public, anon, authenticated;

revoke all on function public.mark_kafka_payment_attempt_processing(
  bigint,
  uuid
) from public, anon, authenticated;

revoke all on function public.finalize_kafka_payment_attempt(
  bigint,
  uuid,
  public.kafka_payment_attempt_status,
  text,
  text,
  text,
  text,
  text,
  jsonb
) from public, anon, authenticated;

grant execute on function public.kafka_payment_attempt_response(uuid)
to service_role;

grant execute on function public.reserve_kafka_payment_attempt(
  bigint,
  uuid,
  text,
  text
) to service_role;

grant execute on function public.mark_kafka_payment_attempt_processing(
  bigint,
  uuid
) to service_role;

grant execute on function public.finalize_kafka_payment_attempt(
  bigint,
  uuid,
  public.kafka_payment_attempt_status,
  text,
  text,
  text,
  text,
  text,
  jsonb
) to service_role;

-- These RPCs are intentionally executable only by service_role.
-- The Edge Function must never log or persist Culqi source tokens; the token is
-- used only to compute a one-way idempotency fingerprint during reservation.
