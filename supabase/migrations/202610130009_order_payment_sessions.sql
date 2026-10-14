-- Kafka Payments v1 Fase 3C.1: temporary payment sessions for guest checkout.
-- Review and apply manually after 202610130008_claim_payment_attempt_processing.sql.
-- This migration does not call Culqi and does not modify existing orders.

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.order_payment_sessions (
  id uuid primary key default gen_random_uuid(),
  store_id bigint not null,
  order_id uuid not null,
  token_hash text not null,
  status text not null default 'active',
  expires_at timestamptz not null,
  used_at timestamptz null,
  revoked_at timestamptz null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz null,
  use_count integer not null default 0,
  constraint order_payment_sessions_order_fk
    foreign key (store_id, order_id)
    references public.orders (store_id, id)
    on delete restrict,
  constraint order_payment_sessions_token_hash_format
    check (token_hash ~ '^[a-f0-9]{64}$'),
  constraint order_payment_sessions_status_check
    check (status in ('active', 'used', 'revoked', 'expired')),
  constraint order_payment_sessions_expiration_check
    check (expires_at > created_at),
  constraint order_payment_sessions_use_count_check
    check (use_count >= 0)
);

alter table public.order_payment_sessions enable row level security;

revoke all on table public.order_payment_sessions from public, anon, authenticated;
grant select, insert, update on table public.order_payment_sessions to service_role;

create unique index if not exists order_payment_sessions_token_hash_unique
on public.order_payment_sessions (token_hash);

create unique index if not exists order_payment_sessions_one_active_order_idx
on public.order_payment_sessions (store_id, order_id)
where status = 'active';

create index if not exists order_payment_sessions_order_idx
on public.order_payment_sessions (store_id, order_id, status, expires_at);

create or replace function public.create_kafka_online_order_with_payment_session(
  p_store_id bigint,
  p_customer_name text,
  p_customer_phone text,
  p_customer_email text,
  p_idempotency_key text,
  p_whatsapp_message text,
  p_items jsonb,
  p_payment_session_token_hash text,
  p_payment_session_expires_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized_idempotency_key text;
  normalized_token_hash text;
  existing_order_id uuid;
  order_response jsonb;
  inserted_session public.order_payment_sessions%rowtype;
begin
  if p_store_id is null or p_store_id <= 0 then
    raise exception 'tienda invalida';
  end if;

  normalized_idempotency_key := btrim(coalesce(p_idempotency_key, ''));
  normalized_token_hash := lower(btrim(coalesce(p_payment_session_token_hash, '')));

  if length(normalized_idempotency_key) = 0 or length(normalized_idempotency_key) > 120 then
    raise exception 'idempotency key requerida';
  end if;

  if normalized_token_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'sesion de pago invalida';
  end if;

  if p_payment_session_expires_at is null
    or p_payment_session_expires_at < now() + interval '5 minutes'
    or p_payment_session_expires_at > now() + interval '30 minutes'
  then
    raise exception 'expiracion de sesion de pago invalida';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_store_id::text || ':' || normalized_idempotency_key, 0)
  );

  select orders.id
  into existing_order_id
  from public.orders
  where orders.store_id = p_store_id
    and orders.idempotency_key = normalized_idempotency_key;

  order_response := public.create_kafka_order(
    p_store_id,
    p_customer_name,
    p_customer_phone,
    p_customer_email,
    normalized_idempotency_key,
    p_whatsapp_message,
    p_items
  );

  if existing_order_id is not null then
    return jsonb_build_object(
      'order', order_response,
      'payment_session_created', false
    );
  end if;

  insert into public.order_payment_sessions (
    store_id,
    order_id,
    token_hash,
    status,
    expires_at
  )
  values (
    p_store_id,
    (order_response->>'id')::uuid,
    normalized_token_hash,
    'active',
    p_payment_session_expires_at
  )
  returning *
  into inserted_session;

  return jsonb_build_object(
    'order', order_response,
    'payment_session_created', true,
    'payment_session', jsonb_build_object(
      'expires_at', inserted_session.expires_at
    )
  );
end;
$$;

create or replace function public.validate_order_payment_session(
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
  locked_order public.orders%rowtype;
  locked_session public.order_payment_sessions%rowtype;
begin
  if p_store_id is null or p_store_id <= 0 then
    raise exception 'sesion de pago invalida';
  end if;

  if p_order_id is null then
    raise exception 'sesion de pago invalida';
  end if;

  normalized_token_hash := lower(btrim(coalesce(p_token_hash, '')));

  if normalized_token_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'sesion de pago invalida';
  end if;

  select *
  into locked_order
  from public.orders
  where orders.store_id = p_store_id
    and orders.id = p_order_id
  for update;

  if not found then
    raise exception 'sesion de pago invalida';
  end if;

  if locked_order.status = 'paid' then
    raise exception 'orden ya pagada';
  end if;

  if locked_order.status not in ('pending_payment', 'payment_failed') then
    raise exception 'estado de orden invalido para pago';
  end if;

  select *
  into locked_session
  from public.order_payment_sessions
  where order_payment_sessions.store_id = p_store_id
    and order_payment_sessions.order_id = p_order_id
    and order_payment_sessions.token_hash = normalized_token_hash
  for update;

  if not found then
    raise exception 'sesion de pago invalida';
  end if;

  if locked_session.status <> 'active' then
    raise exception 'sesion de pago invalida';
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

  return jsonb_build_object(
    'valid', true,
    'store_id', locked_session.store_id,
    'order_id', locked_session.order_id,
    'expires_at', locked_session.expires_at
  );
end;
$$;

create or replace function public.revoke_order_payment_sessions(
  p_store_id bigint,
  p_order_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  locked_order public.orders%rowtype;
  revoked_count integer;
begin
  if p_store_id is null or p_store_id <= 0 or p_order_id is null then
    raise exception 'sesion de pago invalida';
  end if;

  select *
  into locked_order
  from public.orders
  where orders.store_id = p_store_id
    and orders.id = p_order_id
  for update;

  if not found then
    raise exception 'sesion de pago invalida';
  end if;

  update public.order_payment_sessions
  set status = 'revoked',
      revoked_at = now(),
      last_used_at = now()
  where order_payment_sessions.store_id = p_store_id
    and order_payment_sessions.order_id = p_order_id
    and order_payment_sessions.status = 'active';

  get diagnostics revoked_count = row_count;

  return jsonb_build_object('revoked_count', revoked_count);
end;
$$;

revoke all on function public.create_kafka_online_order_with_payment_session(
  bigint,
  text,
  text,
  text,
  text,
  text,
  jsonb,
  text,
  timestamptz
) from public, anon, authenticated;

revoke all on function public.validate_order_payment_session(
  bigint,
  uuid,
  text
) from public, anon, authenticated;

revoke all on function public.revoke_order_payment_sessions(
  bigint,
  uuid
) from public, anon, authenticated;

grant execute on function public.create_kafka_online_order_with_payment_session(
  bigint,
  text,
  text,
  text,
  text,
  text,
  jsonb,
  text,
  timestamptz
) to service_role;

grant execute on function public.validate_order_payment_session(
  bigint,
  uuid,
  text
) to service_role;

grant execute on function public.revoke_order_payment_sessions(
  bigint,
  uuid
) to service_role;

-- The raw payment session token is generated by the Edge Function and is never
-- stored in PostgreSQL. Only its SHA-256 hash is persisted.
