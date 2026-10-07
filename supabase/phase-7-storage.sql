alter table public.products
add column if not exists image_path text;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'product-images',
  'product-images',
  true,
  5242880,
  array['image/webp', 'image/png', 'image/jpeg']
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "public read product images" on storage.objects;
drop policy if exists "authenticated users upload own product images" on storage.objects;
drop policy if exists "authenticated users update own product images" on storage.objects;
drop policy if exists "authenticated users delete own product images" on storage.objects;

create policy "public read product images"
on storage.objects
for select
to anon, authenticated
using (bucket_id = 'product-images');

create policy "authenticated users upload own product images"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'product-images'
  and exists (
    select 1
    from public.stores
    join public.products on products.store_id = stores.id
    where stores.id = (storage.foldername(storage.objects.name))[1]::bigint
    and products.id = (storage.foldername(storage.objects.name))[2]::bigint
    and stores.owner_user_id = auth.uid()
  )
);

create policy "authenticated users update own product images"
on storage.objects
for update
to authenticated
using (
  bucket_id = 'product-images'
  and exists (
    select 1
    from public.stores
    join public.products on products.store_id = stores.id
    where stores.id = (storage.foldername(storage.objects.name))[1]::bigint
    and products.id = (storage.foldername(storage.objects.name))[2]::bigint
    and stores.owner_user_id = auth.uid()
  )
)
with check (
  bucket_id = 'product-images'
  and exists (
    select 1
    from public.stores
    join public.products on products.store_id = stores.id
    where stores.id = (storage.foldername(storage.objects.name))[1]::bigint
    and products.id = (storage.foldername(storage.objects.name))[2]::bigint
    and stores.owner_user_id = auth.uid()
  )
);

create policy "authenticated users delete own product images"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'product-images'
  and exists (
    select 1
    from public.stores
    join public.products on products.store_id = stores.id
    where stores.id = (storage.foldername(storage.objects.name))[1]::bigint
    and products.id = (storage.foldername(storage.objects.name))[2]::bigint
    and stores.owner_user_id = auth.uid()
  )
);
