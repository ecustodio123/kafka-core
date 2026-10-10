alter table public.categories
add column if not exists image_url text;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'category-images',
  'category-images',
  true,
  2097152,
  array['image/webp', 'image/png', 'image/jpeg']
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "public read category images" on storage.objects;
drop policy if exists "authenticated users read own category images" on storage.objects;
drop policy if exists "authenticated users upload own category images" on storage.objects;
drop policy if exists "authenticated users update own category images" on storage.objects;
drop policy if exists "authenticated users delete own category images" on storage.objects;
drop policy if exists "Authenticated users can upload category images" on storage.objects;
drop policy if exists "Authenticated users can update category images" on storage.objects;
drop policy if exists "Authenticated users can delete category images" on storage.objects;

create or replace function public.kafka_storage_category_store_id(segment text)
returns bigint
language plpgsql
immutable
as $$
begin
  if segment is null or segment !~ '^[0-9]+($|-)' then
    return null;
  end if;

  return split_part(segment, '-', 1)::bigint;
exception
  when invalid_text_representation or numeric_value_out_of_range then
    return null;
end;
$$;

create or replace function public.kafka_storage_category_uuid(segment text)
returns uuid
language sql
immutable
as $$
  select case
    when segment ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}($|-)'
      then substring(segment from 1 for 36)::uuid
    else null::uuid
  end;
$$;

create policy "authenticated users read own category images"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'category-images'
  and exists (
    select 1
    from public.stores
    join public.categories on categories.store_id = stores.id
    where stores.id = public.kafka_storage_category_store_id(
      (storage.foldername(storage.objects.name))[1]
    )
      and categories.id = case
        when (storage.foldername(storage.objects.name))[2] = 'categories'
          then public.kafka_storage_category_uuid((storage.foldername(storage.objects.name))[3])
        else public.kafka_storage_category_uuid((storage.foldername(storage.objects.name))[2])
      end
      and stores.owner_user_id = auth.uid()
  )
);

create policy "authenticated users upload own category images"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'category-images'
  and exists (
    select 1
    from public.stores
    join public.categories on categories.store_id = stores.id
    where stores.id = public.kafka_storage_category_store_id(
      (storage.foldername(storage.objects.name))[1]
    )
      and categories.id = case
        when (storage.foldername(storage.objects.name))[2] = 'categories'
          then public.kafka_storage_category_uuid((storage.foldername(storage.objects.name))[3])
        else public.kafka_storage_category_uuid((storage.foldername(storage.objects.name))[2])
      end
      and stores.owner_user_id = auth.uid()
  )
);

create policy "authenticated users update own category images"
on storage.objects
for update
to authenticated
using (
  bucket_id = 'category-images'
  and exists (
    select 1
    from public.stores
    join public.categories on categories.store_id = stores.id
    where stores.id = public.kafka_storage_category_store_id(
      (storage.foldername(storage.objects.name))[1]
    )
      and categories.id = case
        when (storage.foldername(storage.objects.name))[2] = 'categories'
          then public.kafka_storage_category_uuid((storage.foldername(storage.objects.name))[3])
        else public.kafka_storage_category_uuid((storage.foldername(storage.objects.name))[2])
      end
      and stores.owner_user_id = auth.uid()
  )
)
with check (
  bucket_id = 'category-images'
  and exists (
    select 1
    from public.stores
    join public.categories on categories.store_id = stores.id
    where stores.id = public.kafka_storage_category_store_id(
      (storage.foldername(storage.objects.name))[1]
    )
      and categories.id = case
        when (storage.foldername(storage.objects.name))[2] = 'categories'
          then public.kafka_storage_category_uuid((storage.foldername(storage.objects.name))[3])
        else public.kafka_storage_category_uuid((storage.foldername(storage.objects.name))[2])
      end
      and stores.owner_user_id = auth.uid()
  )
);

create policy "authenticated users delete own category images"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'category-images'
  and exists (
    select 1
    from public.stores
    join public.categories on categories.store_id = stores.id
    where stores.id = public.kafka_storage_category_store_id(
      (storage.foldername(storage.objects.name))[1]
    )
      and categories.id = case
        when (storage.foldername(storage.objects.name))[2] = 'categories'
          then public.kafka_storage_category_uuid((storage.foldername(storage.objects.name))[3])
        else public.kafka_storage_category_uuid((storage.foldername(storage.objects.name))[2])
      end
      and stores.owner_user_id = auth.uid()
  )
);
