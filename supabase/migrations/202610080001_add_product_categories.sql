-- Kafka Core - Phase 7.1: Product categories
-- Review before applying. This migration is designed for the current schema
-- where stores.id and products.store_id are bigint-compatible numeric ids.

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.categories (
  id uuid primary key default gen_random_uuid(),
  store_id bigint not null references public.stores(id),
  name text not null,
  slug text not null,
  image_url text null,
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint categories_name_not_empty check (length(btrim(name)) > 0),
  constraint categories_slug_not_empty check (length(btrim(slug)) > 0),
  constraint categories_store_slug_unique unique (store_id, slug),
  constraint categories_store_id_id_unique unique (store_id, id)
);

create index if not exists categories_store_active_sort_idx
on public.categories (store_id, active, sort_order, name);

alter table public.products
add column if not exists category_id uuid null;

create index if not exists products_store_category_idx
on public.products (store_id, category_id);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'products_store_category_fk'
      and conrelid = 'public.products'::regclass
  ) then
    alter table public.products
    add constraint products_store_category_fk
    foreign key (store_id, category_id)
    references public.categories (store_id, id)
    on update cascade;
  end if;
end $$;

alter table public.categories enable row level security;

grant usage on schema public to anon, authenticated;
grant select on public.categories to anon, authenticated;
grant insert, update, delete on public.categories to authenticated;

drop policy if exists "anon can read active categories" on public.categories;
drop policy if exists "authenticated users read own categories" on public.categories;
drop policy if exists "authenticated users insert own categories" on public.categories;
drop policy if exists "authenticated users update own categories" on public.categories;
drop policy if exists "authenticated users delete own categories" on public.categories;

-- Public catalog reads.
-- Limitation: the current schema has no stores.active/stores.published flag.
-- This policy exposes only active category names/slugs/order, but it cannot
-- additionally verify store publication until a store-level public flag exists.
create policy "anon can read active categories"
on public.categories
for select
to anon
using (active = true);

create policy "authenticated users read own categories"
on public.categories
for select
to authenticated
using (
  exists (
    select 1
    from public.stores
    where stores.id = categories.store_id
      and stores.owner_user_id = auth.uid()
  )
);

create policy "authenticated users insert own categories"
on public.categories
for insert
to authenticated
with check (
  exists (
    select 1
    from public.stores
    where stores.id = categories.store_id
      and stores.owner_user_id = auth.uid()
  )
);

create policy "authenticated users update own categories"
on public.categories
for update
to authenticated
using (
  exists (
    select 1
    from public.stores
    where stores.id = categories.store_id
      and stores.owner_user_id = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.stores
    where stores.id = categories.store_id
      and stores.owner_user_id = auth.uid()
  )
);

create policy "authenticated users delete own categories"
on public.categories
for delete
to authenticated
using (
  exists (
    select 1
    from public.stores
    where stores.id = categories.store_id
      and stores.owner_user_id = auth.uid()
  )
);
