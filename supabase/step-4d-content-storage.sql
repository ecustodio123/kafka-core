-- DRAFT 4D: review and apply MANUALLY as postgres, only after auditing effective
-- storage.objects policies. Existing broad permissive policies can OR-bypass
-- these restrictions; this file deliberately does not change Commerce policies.
-- No UPDATE/DELETE policies: uploads never overwrite, old objects are retained.
begin;

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values
  ('service-images','service-images',true,2097152,array['image/webp']),
  ('staff-images','staff-images',true,2097152,array['image/webp'])
on conflict (id) do nothing;

do $$
begin
  if to_regprocedure('kafka_modules.can_manage(bigint,text)') is null then
    raise exception '4D: requiere las funciones del Paso 4B';
  end if;
  if exists (select 1 from storage.buckets b
    where b.id in ('service-images','staff-images') and (
      b.public is not true or b.file_size_limit is distinct from 2097152::bigint
      or b.allowed_mime_types is distinct from array['image/webp']::text[])) then
    raise exception '4D: bucket existente incompatible; revisar sin sobrescribir su configuracion';
  end if;
  if not exists (select 1 from pg_class c where c.oid = 'storage.objects'::regclass and c.relrowsecurity) then
    raise exception '4D: Storage debe conservar RLS habilitado';
  end if;
end;
$$;

create or replace function kafka_modules.can_manage_module_image(p_bucket text, p_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  with path as (select pg_catalog.string_to_array(p_name, '/') as parts)
  select coalesce(
    pg_catalog.array_length(parts, 1) = 4
    and parts[1] ~ '^[1-9][0-9]*-[a-z0-9]+(-[a-z0-9]+)*$'
    and parts[3] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[a-z0-9]+(-[a-z0-9]+)*$'
    and parts[4] ~ '^principal-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$'
    and (
      p_bucket = 'service-images' and parts[2] = 'services' and exists (
        select 1 from public.services r join public.stores s on s.id = r.store_id
        where s.id::text = pg_catalog.split_part(parts[1], '-', 1)
          and r.id::text = pg_catalog.left(parts[3], 36)
          and kafka_modules.can_manage(s.id, 'services'))
      or p_bucket = 'staff-images' and parts[2] = 'staff' and exists (
        select 1 from public.staff r join public.stores s on s.id = r.store_id
        where s.id::text = pg_catalog.split_part(parts[1], '-', 1)
          and r.id::text = pg_catalog.left(parts[3], 36)
          and kafka_modules.can_manage(s.id, 'staff'))
    ), false)
  from path;
$$;

revoke all on function kafka_modules.can_manage_module_image(text,text) from public, anon, authenticated, service_role;
grant execute on function kafka_modules.can_manage_module_image(text,text) to authenticated;

drop policy if exists kafka_4d_module_images_read on storage.objects;
create policy kafka_4d_module_images_read on storage.objects for select to authenticated
using (bucket_id in ('service-images','staff-images') and kafka_modules.can_manage_module_image(bucket_id,name));
drop policy if exists kafka_4d_module_images_insert on storage.objects;
create policy kafka_4d_module_images_insert on storage.objects for insert to authenticated
with check (bucket_id in ('service-images','staff-images') and kafka_modules.can_manage_module_image(bucket_id,name));

commit;
