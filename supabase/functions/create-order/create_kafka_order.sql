-- SQL reference for supabase/functions/create-order.
-- The versioned migration is:
-- supabase/migrations/202610130003_create_order_rpc.sql
-- Apply the migration manually before deploying the Edge Function.

create extension if not exists pgcrypto with schema extensions;

alter table public.orders
add column if not exists idempotency_fingerprint text null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'orders_idempotency_fingerprint_format'
      and conrelid = 'public.orders'::regclass
  ) then
    alter table public.orders
    add constraint orders_idempotency_fingerprint_format
    check (
      idempotency_fingerprint is null
      or idempotency_fingerprint ~ '^[a-f0-9]{64}$'
    );
  end if;
end $$;

create or replace function public.create_kafka_order(
  p_store_id bigint,
  p_customer_name text,
  p_customer_phone text,
  p_customer_email text,
  p_idempotency_key text,
  p_whatsapp_message text,
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  max_integer constant numeric := 2147483647;
  max_bigint constant numeric := 9223372036854775807;
  existing_order public.orders%rowtype;
  inserted_order public.orders%rowtype;
  normalized_customer_name text;
  normalized_customer_phone text;
  normalized_customer_email text;
  normalized_whatsapp_message text;
  normalized_idempotency_key text;
  normalized_items jsonb;
  request_fingerprint text;
  raw_item_count integer;
  normalized_item_count integer;
  invalid_item_count integer;
  locked_product_count integer;
  invalid_amount_count integer;
  subtotal_cents numeric;
  total_cents numeric;
begin
  if p_store_id is null or p_store_id <= 0 then
    raise exception 'tienda invalida';
  end if;

  if not exists (
    select 1
    from public.stores
    where stores.id = p_store_id
  ) then
    raise exception 'tienda invalida';
  end if;

  normalized_customer_name := btrim(coalesce(p_customer_name, ''));
  normalized_customer_phone := btrim(coalesce(p_customer_phone, ''));
  normalized_customer_email := nullif(btrim(coalesce(p_customer_email, '')), '');
  normalized_whatsapp_message := nullif(btrim(coalesce(p_whatsapp_message, '')), '');
  normalized_idempotency_key := btrim(coalesce(p_idempotency_key, ''));

  if length(normalized_customer_name) = 0 or length(normalized_customer_name) > 120 then
    raise exception 'comprador invalido';
  end if;

  if length(normalized_customer_phone) = 0 or length(normalized_customer_phone) > 32 then
    raise exception 'comprador invalido';
  end if;

  if normalized_customer_email is not null and length(normalized_customer_email) > 180 then
    raise exception 'comprador invalido';
  end if;

  if normalized_whatsapp_message is not null and length(normalized_whatsapp_message) > 4000 then
    raise exception 'whatsapp_message invalido';
  end if;

  if length(normalized_idempotency_key) = 0 or length(normalized_idempotency_key) > 120 then
    raise exception 'idempotency key requerida';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'payload de productos invalido';
  end if;

  if jsonb_array_length(p_items) = 0 or jsonb_array_length(p_items) > 50 then
    raise exception 'payload de productos invalido';
  end if;

  with raw_items as (
    select
      item.value as item,
      item.ordinality
    from jsonb_array_elements(p_items) with ordinality as item(value, ordinality)
  ),
  item_text_values as (
    select
      item,
      case when jsonb_typeof(item) = 'object' then btrim(item->>'product_id') end as product_id_text,
      case when jsonb_typeof(item) = 'object' then btrim(item->>'quantity') end as quantity_text
    from raw_items
  ),
  item_numeric_values as (
    select
      product_id_text,
      quantity_text,
      case
        when product_id_text ~ '^[1-9][0-9]*$'
          then product_id_text::numeric
        else null::numeric
      end as product_id_numeric,
      case
        when quantity_text ~ '^[1-9][0-9]*$'
          then quantity_text::numeric
        else null::numeric
      end as quantity_numeric
    from item_text_values
  ),
  parsed_items as (
    select
      case
        when product_id_numeric between 1 and max_bigint
          then product_id_numeric::bigint
        else null::bigint
      end as product_id,
      case
        when quantity_numeric between 1 and 99
          then quantity_numeric::integer
        else null::integer
      end as quantity,
      case
        when product_id_numeric between 1 and max_bigint
          and quantity_numeric between 1 and 99
          then false
        else true
      end as is_invalid
    from item_numeric_values
  ),
  grouped_items as (
    select
      product_id,
      sum(quantity)::integer as quantity
    from parsed_items
    where not is_invalid
    group by product_id
  ),
  validation as (
    select
      (select count(*) from raw_items)::integer as raw_item_count,
      (select count(*) from grouped_items)::integer as normalized_item_count,
      (
        select count(*)
        from parsed_items
        where is_invalid
      )::integer
      + (
        select count(*)
        from grouped_items
        where quantity <= 0 or quantity > 99
      )::integer as invalid_item_count,
      (
        select jsonb_agg(
          jsonb_build_object(
            'product_id', grouped_items.product_id,
            'quantity', grouped_items.quantity
          )
          order by grouped_items.product_id
        )
        from grouped_items
      ) as normalized_items
  )
  select
    validation.raw_item_count,
    validation.normalized_item_count,
    validation.invalid_item_count,
    validation.normalized_items
  into
    raw_item_count,
    normalized_item_count,
    invalid_item_count,
    normalized_items
  from validation;

  if raw_item_count = 0
    or raw_item_count > 50
    or normalized_item_count = 0
    or normalized_item_count > 50
    or invalid_item_count > 0
    or normalized_items is null
  then
    raise exception 'payload de productos invalido';
  end if;

  request_fingerprint := pg_catalog.encode(
    extensions.digest(
      jsonb_build_object(
        'store_id', p_store_id,
        'customer', jsonb_build_object(
          'name', normalized_customer_name,
          'phone', normalized_customer_phone,
          'email', normalized_customer_email,
          'whatsapp_message', normalized_whatsapp_message
        ),
        'items', normalized_items
      )::text,
      'sha256'
    ),
    'hex'
  );

  perform pg_advisory_xact_lock(
    hashtextextended(p_store_id::text || ':' || normalized_idempotency_key, 0)
  );

  select *
  into existing_order
  from public.orders
  where store_id = p_store_id
    and idempotency_key = normalized_idempotency_key;

  if found then
    if existing_order.idempotency_fingerprint is distinct from request_fingerprint then
      raise exception 'idempotency key conflict';
    end if;

    return public.kafka_order_response(existing_order.id);
  end if;

  with requested_items as (
    select *
    from jsonb_to_recordset(normalized_items) as item(product_id bigint, quantity integer)
  ),
  locked_products as (
    select products.id
    from public.products
    join requested_items
      on requested_items.product_id = products.id
    where products.store_id = p_store_id
      and products.active = true
      and products.available = true
    for share of products
  )
  select count(*)::integer
  into locked_product_count
  from locked_products;

  if locked_product_count <> normalized_item_count then
    raise exception 'producto invalido o producto no disponible';
  end if;

  with requested_items as (
    select *
    from jsonb_to_recordset(normalized_items) as item(product_id bigint, quantity integer)
  ),
  calculated_items as (
    select
      products.id as product_id,
      products.name as product_name,
      requested_items.quantity,
      round(products.price * 100) as unit_price_cents,
      case
        when products.discount_active = true
          and products.discount_price is not null
          and products.discount_price > 0
          and products.discount_price < products.price
          then round(products.discount_price * 100)
        else null::numeric
      end as unit_discount_price_cents,
      case
        when products.discount_active = true
          and products.discount_price is not null
          and products.discount_price > 0
          and products.discount_price < products.price
          then round(products.discount_price * 100)
        else round(products.price * 100)
      end as final_unit_price_cents
    from requested_items
    join public.products
      on products.id = requested_items.product_id
      and products.store_id = p_store_id
  )
  select count(*)::integer
  into invalid_amount_count
  from calculated_items
  where unit_price_cents < 0
    or unit_price_cents > max_integer
    or final_unit_price_cents <= 0
    or final_unit_price_cents > max_integer
    or (final_unit_price_cents * quantity) > max_integer;

  if invalid_amount_count > 0 then
    raise exception 'monto de producto invalido';
  end if;

  with requested_items as (
    select *
    from jsonb_to_recordset(normalized_items) as item(product_id bigint, quantity integer)
  ),
  calculated_items as (
    select
      products.id as product_id,
      products.name as product_name,
      requested_items.quantity,
      round(products.price * 100) as unit_price_cents,
      case
        when products.discount_active = true
          and products.discount_price is not null
          and products.discount_price > 0
          and products.discount_price < products.price
          then round(products.discount_price * 100)
        else null::numeric
      end as unit_discount_price_cents,
      case
        when products.discount_active = true
          and products.discount_price is not null
          and products.discount_price > 0
          and products.discount_price < products.price
          then round(products.discount_price * 100)
        else round(products.price * 100)
      end as final_unit_price_cents
    from requested_items
    join public.products
      on products.id = requested_items.product_id
      and products.store_id = p_store_id
  )
  select
    coalesce(sum(unit_price_cents * quantity), 0),
    coalesce(sum(final_unit_price_cents * quantity), 0)
  into subtotal_cents, total_cents
  from calculated_items;

  if total_cents <= 0
    or total_cents > max_integer
    or subtotal_cents > max_integer
    or (subtotal_cents - total_cents) > max_integer
  then
    raise exception 'total de orden invalido';
  end if;

  insert into public.orders (
    store_id,
    customer_name,
    customer_phone,
    customer_email,
    status,
    currency,
    subtotal_amount_cents,
    discount_amount_cents,
    total_amount_cents,
    whatsapp_message,
    idempotency_key,
    idempotency_fingerprint
  )
  values (
    p_store_id,
    normalized_customer_name,
    normalized_customer_phone,
    normalized_customer_email,
    'pending_payment',
    'PEN',
    subtotal_cents::integer,
    (subtotal_cents - total_cents)::integer,
    total_cents::integer,
    normalized_whatsapp_message,
    normalized_idempotency_key,
    request_fingerprint
  )
  returning *
  into inserted_order;

  with requested_items as (
    select *
    from jsonb_to_recordset(normalized_items) as item(product_id bigint, quantity integer)
  ),
  calculated_items as (
    select
      products.id as product_id,
      products.name as product_name,
      requested_items.quantity,
      round(products.price * 100) as unit_price_cents,
      case
        when products.discount_active = true
          and products.discount_price is not null
          and products.discount_price > 0
          and products.discount_price < products.price
          then round(products.discount_price * 100)
        else null::numeric
      end as unit_discount_price_cents,
      case
        when products.discount_active = true
          and products.discount_price is not null
          and products.discount_price > 0
          and products.discount_price < products.price
          then round(products.discount_price * 100)
        else round(products.price * 100)
      end as final_unit_price_cents
    from requested_items
    join public.products
      on products.id = requested_items.product_id
      and products.store_id = p_store_id
  )
  insert into public.order_items (
    order_id,
    store_id,
    product_id,
    product_name,
    quantity,
    unit_price_cents,
    unit_discount_price_cents,
    final_unit_price_cents,
    line_total_cents
  )
  select
    inserted_order.id,
    p_store_id,
    product_id,
    product_name,
    quantity,
    unit_price_cents::integer,
    unit_discount_price_cents::integer,
    final_unit_price_cents::integer,
    (final_unit_price_cents * quantity)::integer
  from calculated_items;

  return public.kafka_order_response(inserted_order.id);
exception
  when unique_violation then
    select *
    into existing_order
    from public.orders
    where store_id = p_store_id
      and idempotency_key = normalized_idempotency_key;

    if found then
      if existing_order.idempotency_fingerprint is distinct from request_fingerprint then
        raise exception 'idempotency key conflict';
      end if;

      return public.kafka_order_response(existing_order.id);
    end if;

    raise;
end;
$$;

create or replace function public.kafka_order_response(p_order_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', orders.id,
    'store_id', orders.store_id,
    'status', orders.status,
    'currency', orders.currency,
    'subtotal_amount_cents', orders.subtotal_amount_cents,
    'discount_amount_cents', orders.discount_amount_cents,
    'total_amount_cents', orders.total_amount_cents,
    'idempotency_key', orders.idempotency_key,
    'created_at', orders.created_at,
    'items', coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', order_items.id,
          'product_id', order_items.product_id,
          'product_name', order_items.product_name,
          'quantity', order_items.quantity,
          'unit_price_cents', order_items.unit_price_cents,
          'unit_discount_price_cents', order_items.unit_discount_price_cents,
          'final_unit_price_cents', order_items.final_unit_price_cents,
          'line_total_cents', order_items.line_total_cents
        )
        order by order_items.created_at, order_items.id
      ) filter (where order_items.id is not null),
      '[]'::jsonb
    )
  )
  from public.orders
  left join public.order_items on order_items.order_id = orders.id
    and order_items.store_id = orders.store_id
  where orders.id = p_order_id
  group by orders.id;
$$;

revoke all on function public.create_kafka_order(
  bigint,
  text,
  text,
  text,
  text,
  text,
  jsonb
) from public, anon, authenticated;

revoke all on function public.kafka_order_response(uuid) from public, anon, authenticated;

grant execute on function public.create_kafka_order(
  bigint,
  text,
  text,
  text,
  text,
  text,
  jsonb
) to service_role;

grant execute on function public.kafka_order_response(uuid) to service_role;

-- The create-order Edge Function uses the service role key to execute this RPC.
-- Do not grant execute to anon or authenticated.
