alter table public.stores
add column if not exists owner_user_id uuid references auth.users(id);

alter table public.stores enable row level security;
alter table public.products enable row level security;

grant usage on schema public to anon, authenticated;
grant select on public.stores to authenticated;
grant select, insert, update on public.products to authenticated;
grant usage, select on all sequences in schema public to authenticated;

drop policy if exists "temporary anon read store 1" on public.stores;
drop policy if exists "temporary anon read products store 1" on public.products;
drop policy if exists "temporary anon insert products store 1" on public.products;
drop policy if exists "temporary anon update products store 1" on public.products;

drop policy if exists "authenticated users read own store" on public.stores;
drop policy if exists "authenticated users read own products" on public.products;
drop policy if exists "authenticated users insert own products" on public.products;
drop policy if exists "authenticated users update own products" on public.products;

create policy "authenticated users read own store"
on public.stores
for select
to authenticated
using (owner_user_id = auth.uid());

create policy "authenticated users read own products"
on public.products
for select
to authenticated
using (
  exists (
    select 1
    from public.stores
    where stores.id = products.store_id
    and stores.owner_user_id = auth.uid()
  )
);

create policy "authenticated users insert own products"
on public.products
for insert
to authenticated
with check (
  exists (
    select 1
    from public.stores
    where stores.id = products.store_id
    and stores.owner_user_id = auth.uid()
  )
);

create policy "authenticated users update own products"
on public.products
for update
to authenticated
using (
  exists (
    select 1
    from public.stores
    where stores.id = products.store_id
    and stores.owner_user_id = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.stores
    where stores.id = products.store_id
    and stores.owner_user_id = auth.uid()
  )
);

-- Despues de crear el usuario en Supabase Auth, asocialo a una tienda:
-- update public.stores
-- set owner_user_id = 'USER_ID_DE_AUTH'
-- where id = 1;

-- Lectura publica para sitios web, si ya quieres habilitarla:
-- create policy "anon can read active products"
-- on public.products
-- for select
-- to anon
-- using (active = true);
