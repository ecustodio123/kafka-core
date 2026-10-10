-- Kafka Commerce Phase 1: product offers, visual rating, and catalog helpers.
-- Review before applying. This migration keeps existing product rows
-- compatible by adding nullable/defaulted fields without deleting data.

alter table public.products
add column if not exists discount_active boolean not null default false;

alter table public.products
add column if not exists discount_price numeric(10, 2) null;

alter table public.products
add column if not exists visual_rating numeric(2, 1) null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'products_price_non_negative'
      and conrelid = 'public.products'::regclass
  ) then
    alter table public.products
    add constraint products_price_non_negative
    check (price >= 0);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'products_discount_price_valid'
      and conrelid = 'public.products'::regclass
  ) then
    alter table public.products
    add constraint products_discount_price_valid
    check (
      discount_price is null
      or (
        discount_price > 0
        and discount_price < price
      )
    );
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'products_discount_active_requires_price'
      and conrelid = 'public.products'::regclass
  ) then
    alter table public.products
    add constraint products_discount_active_requires_price
    check (
      discount_active = false
      or discount_price is not null
    );
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'products_visual_rating_range'
      and conrelid = 'public.products'::regclass
  ) then
    alter table public.products
    add constraint products_visual_rating_range
    check (
      visual_rating is null
      or (
        visual_rating >= 0
        and visual_rating <= 5
      )
    );
  end if;
end $$;

create index if not exists products_store_active_created_idx
on public.products (store_id, active, created_at desc);

create index if not exists products_store_active_name_idx
on public.products (store_id, active, name);

create index if not exists products_store_active_category_idx
on public.products (store_id, active, category_id);

create index if not exists products_store_active_offer_idx
on public.products (store_id, active, discount_active)
where discount_active = true;

create index if not exists products_store_active_final_price_idx
on public.products (
  store_id,
  active,
  (
    case
      when discount_active = true
        and discount_price is not null
        and discount_price > 0
        and discount_price < price
        then discount_price
      else price
    end
  )
);

create or replace view public.kafka_commerce_products
with (security_invoker = true)
as
select
  products.id,
  products.store_id,
  products.category_id,
  products.name,
  products.description,
  products.price,
  products.discount_active,
  products.discount_price,
  case
    when products.discount_active = true
      and products.discount_price is not null
      and products.discount_price > 0
      and products.discount_price < products.price
      then products.discount_price
    else products.price
  end as final_price,
  case
    when products.discount_active = true
      and products.discount_price is not null
      and products.discount_price > 0
      and products.discount_price < products.price
      and products.price > 0
      then round(((products.price - products.discount_price) / products.price) * 100)
    else 0
  end as discount_percent,
  (
    products.discount_active = true
    and products.discount_price is not null
    and products.discount_price > 0
    and products.discount_price < products.price
  ) as in_offer,
  products.visual_rating,
  products.image_path,
  products.available,
  products.active,
  products.created_at
from public.products;

grant select on public.kafka_commerce_products to anon, authenticated;

-- This view preserves products RLS because it is created with security_invoker.
-- Public Kafka Commerce reads still require an explicit products SELECT policy
-- for anon, scoped to the store/catalog rules you want to expose.
