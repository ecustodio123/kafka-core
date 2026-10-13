-- Kafka Payments v1: multi-tenant payment tables for Culqi.
-- Review before applying. This migration creates the storage model only:
-- client-side public writes are intentionally not enabled.

create extension if not exists pgcrypto with schema extensions;
create schema if not exists vault;
create extension if not exists supabase_vault with schema vault;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'kafka_order_status') then
    create type public.kafka_order_status as enum (
      'draft',
      'pending_payment',
      'paid',
      'payment_failed',
      'cancelled',
      'whatsapp_only'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'kafka_payment_attempt_status') then
    create type public.kafka_payment_attempt_status as enum (
      'created',
      'processing',
      'paid',
      'failed',
      'expired',
      'cancelled'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'kafka_payment_event_type') then
    create type public.kafka_payment_event_type as enum (
      'provider_request',
      'provider_response',
      'webhook_received',
      'webhook_verified',
      'status_changed',
      'error'
    );
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'products_store_id_id_unique'
      and conrelid = 'public.products'::regclass
  ) then
    alter table public.products
    add constraint products_store_id_id_unique
    unique (store_id, id);
  end if;
end $$;

create table if not exists public.store_payment_settings (
  id uuid primary key default gen_random_uuid(),
  store_id bigint not null references public.stores(id),
  provider text not null default 'culqi',
  environment text not null default 'test',
  active boolean not null default false,
  culqi_public_key text null,
  culqi_private_key_secret_id uuid null references vault.secrets(id),
  culqi_webhook_secret_id uuid null references vault.secrets(id),
  culqi_enabled boolean not null default false,
  currency char(3) not null default 'PEN',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint store_payment_settings_store_environment_unique unique (store_id, environment),
  constraint store_payment_settings_provider_check check (provider = 'culqi'),
  constraint store_payment_settings_environment_check check (environment in ('test', 'live')),
  constraint store_payment_settings_currency_check check (currency = 'PEN')
);

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  store_id bigint not null references public.stores(id),
  customer_name text not null,
  customer_phone text not null,
  customer_email text null,
  status public.kafka_order_status not null default 'draft',
  currency char(3) not null default 'PEN',
  subtotal_amount_cents integer not null,
  discount_amount_cents integer not null default 0,
  total_amount_cents integer not null,
  whatsapp_message text null,
  idempotency_key text null,
  paid_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint orders_store_id_id_unique unique (store_id, id),
  constraint orders_store_idempotency_unique unique (store_id, idempotency_key),
  constraint orders_customer_name_not_empty check (length(btrim(customer_name)) > 0),
  constraint orders_customer_phone_not_empty check (length(btrim(customer_phone)) > 0),
  constraint orders_currency_check check (currency = 'PEN'),
  constraint orders_amounts_check check (
    subtotal_amount_cents >= 0
    and discount_amount_cents >= 0
    and total_amount_cents >= 0
    and total_amount_cents = subtotal_amount_cents - discount_amount_cents
  )
);

create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null,
  store_id bigint not null,
  product_id bigint null,
  product_name text not null,
  quantity integer not null,
  unit_price_cents integer not null,
  unit_discount_price_cents integer null,
  final_unit_price_cents integer not null,
  line_total_cents integer not null,
  created_at timestamptz not null default now(),
  constraint order_items_order_fk
    foreign key (store_id, order_id)
    references public.orders (store_id, id)
    on delete restrict,
  constraint order_items_product_name_not_empty check (length(btrim(product_name)) > 0),
  constraint order_items_quantity_check check (quantity > 0),
  constraint order_items_amounts_check check (
    unit_price_cents >= 0
    and (
      unit_discount_price_cents is null
      or (
        unit_discount_price_cents > 0
        and unit_discount_price_cents < unit_price_cents
      )
    )
    and final_unit_price_cents >= 0
    and final_unit_price_cents <= unit_price_cents
    and line_total_cents = quantity * final_unit_price_cents
  )
);

create table if not exists public.payment_attempts (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null,
  store_id bigint not null,
  provider text not null default 'culqi',
  environment text not null default 'test',
  status public.kafka_payment_attempt_status not null default 'created',
  amount_cents integer not null,
  currency char(3) not null default 'PEN',
  idempotency_key text not null,
  culqi_charge_id text null,
  culqi_order_id text null,
  failure_code text null,
  failure_message text null,
  provider_reference text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payment_attempts_order_fk
    foreign key (store_id, order_id)
    references public.orders (store_id, id)
    on delete restrict,
  constraint payment_attempts_provider_check check (provider = 'culqi'),
  constraint payment_attempts_environment_check check (environment in ('test', 'live')),
  constraint payment_attempts_currency_check check (currency = 'PEN'),
  constraint payment_attempts_amount_check check (amount_cents > 0),
  constraint payment_attempts_store_id_id_unique unique (store_id, id),
  constraint payment_attempts_store_order_environment_id_unique unique (store_id, order_id, environment, id),
  constraint payment_attempts_store_idempotency_unique unique (store_id, idempotency_key),
  constraint payment_attempts_culqi_charge_unique unique (store_id, environment, provider, culqi_charge_id),
  constraint payment_attempts_culqi_order_unique unique (store_id, environment, provider, culqi_order_id)
);

create table if not exists public.payment_events (
  id uuid primary key default gen_random_uuid(),
  payment_attempt_id uuid not null,
  order_id uuid not null,
  store_id bigint not null,
  provider text not null default 'culqi',
  environment text not null default 'test',
  event_type public.kafka_payment_event_type not null,
  provider_event_id text null,
  provider_reference text null,
  status_before text null,
  status_after text null,
  sanitized_payload jsonb null,
  created_at timestamptz not null default now(),
  constraint payment_events_attempt_fk
    foreign key (store_id, order_id, environment, payment_attempt_id)
    references public.payment_attempts (store_id, order_id, environment, id)
    on delete restrict,
  constraint payment_events_order_fk
    foreign key (store_id, order_id)
    references public.orders (store_id, id)
    on delete restrict,
  constraint payment_events_provider_check check (provider = 'culqi'),
  constraint payment_events_environment_check check (environment in ('test', 'live')),
  constraint payment_events_provider_event_unique unique (store_id, environment, provider, provider_event_id)
);

create index if not exists store_payment_settings_enabled_idx
on public.store_payment_settings (store_id, culqi_enabled);

create unique index if not exists store_payment_settings_one_active_environment_idx
on public.store_payment_settings (store_id, provider)
where active = true;

create index if not exists orders_store_status_created_idx
on public.orders (store_id, status, created_at desc);

create index if not exists orders_store_paid_idx
on public.orders (store_id, paid_at desc)
where paid_at is not null;

create index if not exists order_items_order_idx
on public.order_items (order_id);

create index if not exists order_items_store_product_idx
on public.order_items (store_id, product_id);

create index if not exists payment_attempts_order_created_idx
on public.payment_attempts (order_id, created_at desc);

create index if not exists payment_attempts_store_status_created_idx
on public.payment_attempts (store_id, status, created_at desc);

create index if not exists payment_events_attempt_created_idx
on public.payment_events (payment_attempt_id, created_at desc);

create index if not exists payment_events_store_created_idx
on public.payment_events (store_id, created_at desc);

alter table public.store_payment_settings enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.payment_attempts enable row level security;
alter table public.payment_events enable row level security;

create or replace function public.get_store_payment_settings_admin(requested_store_id bigint)
returns table (
  store_id bigint,
  provider text,
  environment text,
  active boolean,
  culqi_public_key text,
  culqi_enabled boolean,
  currency char(3),
  created_at timestamptz,
  updated_at timestamptz,
  has_culqi_private_key boolean,
  has_culqi_webhook_secret boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    settings.store_id,
    settings.provider,
    settings.environment,
    settings.active,
    settings.culqi_public_key,
    settings.culqi_enabled,
    settings.currency,
    settings.created_at,
    settings.updated_at,
    settings.culqi_private_key_secret_id is not null as has_culqi_private_key,
    settings.culqi_webhook_secret_id is not null as has_culqi_webhook_secret
  from public.store_payment_settings as settings
  join public.stores on public.stores.id = settings.store_id
  where settings.store_id = requested_store_id
    and public.stores.owner_user_id = auth.uid();
$$;

grant usage on schema public to authenticated;
revoke all on public.store_payment_settings from public, anon, authenticated;
revoke all on function public.get_store_payment_settings_admin(bigint) from public, anon, authenticated;
grant execute on function public.get_store_payment_settings_admin(bigint) to authenticated;
grant select on public.orders to authenticated;
grant select on public.order_items to authenticated;
grant select on public.payment_attempts to authenticated;
grant select on public.payment_events to authenticated;

drop policy if exists "authenticated users read own payment settings" on public.store_payment_settings;
drop policy if exists "authenticated users read own orders" on public.orders;
drop policy if exists "authenticated users read own order items" on public.order_items;
drop policy if exists "authenticated users read own payment attempts" on public.payment_attempts;
drop policy if exists "authenticated users read own payment events" on public.payment_events;

create policy "authenticated users read own payment settings"
on public.store_payment_settings
for select
to authenticated
using (
  exists (
    select 1
    from public.stores
    where stores.id = store_payment_settings.store_id
      and stores.owner_user_id = auth.uid()
  )
);

create policy "authenticated users read own orders"
on public.orders
for select
to authenticated
using (
  exists (
    select 1
    from public.stores
    where stores.id = orders.store_id
      and stores.owner_user_id = auth.uid()
  )
);

create policy "authenticated users read own order items"
on public.order_items
for select
to authenticated
using (
  exists (
    select 1
    from public.stores
    where stores.id = order_items.store_id
      and stores.owner_user_id = auth.uid()
  )
);

create policy "authenticated users read own payment attempts"
on public.payment_attempts
for select
to authenticated
using (
  exists (
    select 1
    from public.stores
    where stores.id = payment_attempts.store_id
      and stores.owner_user_id = auth.uid()
  )
);

create policy "authenticated users read own payment events"
on public.payment_events
for select
to authenticated
using (
  exists (
    select 1
    from public.stores
    where stores.id = payment_events.store_id
      and stores.owner_user_id = auth.uid()
  )
);

-- Writes are intentionally left to service-role backend code or future
-- SECURITY DEFINER functions that validate cart prices, Culqi signatures,
-- idempotency, and store ownership before changing payment state.
-- The active Culqi environment for each store is selected by the single
-- store_payment_settings row where active = true.
-- Order totals and payment totals must be reconciled transactionally in the
-- backend when creating orders, creating attempts, and processing webhooks.
-- Financial history is preserved by restrictive foreign keys; stores, orders,
-- payment attempts, and payment events should be archived/cancelled rather
-- than physically deleted.
-- Do not store raw card data, CVV, PAN, or unsanitized provider payloads here.
