-- Review/apply manually as postgres. No Storage files are removed by SQL.
begin;

do $$
begin
  if not exists(select 1 from pg_roles where rolname=current_user and (rolsuper or rolbypassrls)) then
    raise exception 'Apply as a trusted BYPASSRLS owner; global reference checks must not be filtered by RLS';
  end if;
  if exists (select 1 from pg_constraint c where c.contype='f'
    and c.confrelid in ('public.products'::regclass,'public.categories'::regclass)
    and c.confdeltype in ('c','n','d')
    and not (c.conrelid='public.product_creation_operations'::regclass
      and c.confrelid='public.products'::regclass and c.confdeltype='n')) then
    raise exception 'Unreviewed cascading/SET NULL/SET DEFAULT catalog dependency; inspect foreign keys first';
  end if;
  if not exists (select 1 from pg_constraint c where c.conrelid='public.products'::regclass
    and c.confrelid='public.categories'::regclass and c.contype='f' and c.convalidated
    and c.confdeltype in ('a','r')
    and c.conkey=array[(select attnum from pg_attribute where attrelid=c.conrelid and attname='store_id'),
                      (select attnum from pg_attribute where attrelid=c.conrelid and attname='category_id')]::smallint[]
    and c.confkey=array[(select attnum from pg_attribute where attrelid=c.confrelid and attname='store_id'),
                       (select attnum from pg_attribute where attrelid=c.confrelid and attname='id')]::smallint[]) then
    raise exception 'Catalog deletion requires the validated composite category FK without cascading deletion';
  end if;
  if exists (select 1 from pg_attribute a join pg_class c on c.oid=a.attrelid
    join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind in ('r','p','m') and a.attnum>0 and not a.attisdropped
      and a.atttypid in ('text'::regtype,'varchar'::regtype)
      and a.attname ~* '(image|avatar|logo)'
      and (c.relname,a.attname) not in (('products','image_path'),('categories','image_url'),
        ('services','image_url'),('staff','image_url'),('kafka_commerce_products','image_path'))) then
    raise exception 'Unreviewed public image columns: inventory references before applying';
  end if;
  if (select count(*) from information_schema.columns where table_schema='public'
    and (table_name,column_name,data_type) in (('products','id','bigint'),('products','store_id','bigint'),
      ('products','image_path','text'),('categories','id','uuid'),('categories','store_id','bigint'),
      ('categories','image_url','text'),('stores','id','bigint'),('stores','owner_user_id','uuid'),
      ('services','image_url','text'),('staff','image_url','text'),
      ('kafka_commerce_products','image_path','text'))) <> 11 then
    raise exception 'Catalog schema differs from the reviewed contract';
  end if;
end $$;

create schema catalog_media;
revoke all on schema catalog_media from public, anon, authenticated, service_role;
create table catalog_media.settings (
  singleton boolean primary key default true check(singleton),
  storage_base_url text check(storage_base_url ~ '^https://[a-z0-9-]+\.supabase\.co$')
);
insert into catalog_media.settings(singleton) values(true);

create table catalog_media.jobs (
  id uuid primary key default gen_random_uuid(),
  store_id bigint not null references public.stores(id) on delete restrict,
  kind text not null check(kind in ('product','category')),
  entity_id text not null,
  bucket text not null check(bucket in ('product-images','category-images')),
  path text not null,
  state text not null default 'pending' check(state in ('pending','deleting','deleted','failed','retained_shared')),
  retired_at timestamptz,
  claim_token uuid,
  claimed_at timestamptz,
  unique(bucket,path)
);
create index catalog_jobs_entity on catalog_media.jobs(store_id,kind,entity_id);
create table catalog_media.operations (
  store_id bigint not null references public.stores(id) on delete restrict,
  operation_id uuid not null,
  actor_id uuid not null,
  kind text not null,
  entity_id text not null,
  job_id uuid references catalog_media.jobs(id),
  cleanup text not null,
  primary key(store_id,operation_id)
);
alter table catalog_media.settings enable row level security;
alter table catalog_media.jobs enable row level security;
alter table catalog_media.operations enable row level security;
revoke all on all tables in schema catalog_media from public, anon, authenticated, service_role;

-- Decode percent escapes for conservative reference checks; malformed/over-nested
-- references fail closed. No query/fragment or encoded-path alias may hide a reference.
create function catalog_media.decoded(p_value text) returns text
language plpgsql immutable set search_path='' as $$
declare v text:=p_value; result bytea; i integer; round integer; ch text;
begin
  if length(v)>8192 then return null; end if;
  for round in 1..4 loop
    if strpos(v,'%')=0 then return v; end if;
    result:=''::bytea; i:=1;
    while i<=length(v) loop
      ch:=substr(v,i,1);
      if ch='%' then
        if substr(v,i+1,2) !~ '^[0-9a-fA-F]{2}$' then return null; end if;
        result:=result || decode(substr(v,i+1,2),'hex'); i:=i+3;
      else result:=result || convert_to(ch,'UTF8'); i:=i+1;
      end if;
    end loop;
    v:=convert_from(result,'UTF8');
  end loop;
  return null;
exception when others then return null;
end $$;

create function catalog_media.reference_key(p_value text,p_relative boolean) returns text
language plpgsql stable security definer set search_path='' as $$
declare value text:=catalog_media.decoded(p_value); base text; prefix text; target text; bucket text; path text;
begin
  if value is null or strpos(value,E'\\')>0 then return null; end if;
  if p_relative and value ~ '^[1-9][0-9]*(-[a-z0-9-]+)?/[a-zA-Z0-9_./-]+$'
    then bucket:='product-images'; path:=value;
  else
    select storage_base_url into base from catalog_media.settings where singleton;
    foreach prefix in array array['/storage/v1/object/public/','/storage/v1/render/image/public/'] loop
      if base is not null and left(value,length(base || prefix))=base || prefix then
        target:=split_part(split_part(substr(value,length(base || prefix)+1),'?',1),'#',1);
        bucket:=split_part(target,'/',1); path:=substr(target,length(bucket)+2); exit;
      end if;
    end loop;
  end if;
  if bucket is null or bucket not in ('product-images','category-images','service-images','staff-images')
    or path is null or path !~ '^[a-zA-Z0-9_-]+(/[a-zA-Z0-9_.-]+)+$'
    or path ~ '(^|/)\.{1,2}(/|$)' then return null; end if;
  return bucket || '/' || path;
end $$;

create function catalog_media.owned_path(p_store bigint,p_kind text,p_id text,p_ref text)
returns text language plpgsql stable security definer set search_path='' as $$
declare base text; path text; parts text[]; bucket text;
begin
  if p_ref is null then return null; end if;
  bucket:=case p_kind when 'product' then 'product-images' when 'category' then 'category-images' end;
  select storage_base_url into base from catalog_media.settings where singleton;
  if p_kind='product' and p_ref !~ '[:?#%\\]' and left(p_ref,1)<>'/' then path:=p_ref;
  elsif base is not null and left(p_ref,length(base || '/storage/v1/object/public/' || bucket || '/'))=
    base || '/storage/v1/object/public/' || bucket || '/' and p_ref !~ '[?#%\\]' then
    path:=substr(p_ref,length(base || '/storage/v1/object/public/' || bucket || '/')+1);
  else return null;
  end if;
  parts:=string_to_array(path,'/');
  if path ~ '(^|/)\.{1,2}(/|$)' or parts[array_length(parts,1)] !~ '^[a-zA-Z0-9_-]+\.(webp|png|jpg|jpeg)$' then return null; end if;
  if array_length(parts,1)=3 and parts[1]=p_store::text and parts[2]=p_id then return path; end if;
  if array_length(parts,1)=4 and parts[1] ~ ('^' || p_store::text || '-[a-z0-9]+(-[a-z0-9]+)*$')
    and parts[2]=(case p_kind when 'product' then 'products' else 'categories' end)
    and parts[3] ~ ('^' || p_id || '-[a-z0-9]+(-[a-z0-9]+)*$') then return path; end if;
  return null;
end $$;

create function catalog_media.enqueue(p_store bigint,p_kind text,p_id text,p_ref text)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_path text; job uuid;
begin
  v_path:=catalog_media.owned_path(p_store,p_kind,p_id,p_ref);
  if v_path is null then return null; end if;
  perform pg_advisory_xact_lock(721304,1);
  insert into catalog_media.jobs(store_id,kind,entity_id,bucket,path)
  values(p_store,p_kind,p_id,case p_kind when 'product' then 'product-images' else 'category-images' end,v_path)
  on conflict(bucket,path) do nothing returning id into job;
  if job is null then select id into job from catalog_media.jobs j where j.path=v_path
    and j.bucket=case p_kind when 'product' then 'product-images' else 'category-images' end; end if;
  return job;
end $$;

create function catalog_media.guard_reference() returns trigger
language plpgsql security definer set search_path='' as $$
declare value text; old_value text;
begin
  value:=to_jsonb(new)->>tg_argv[0];
  if tg_op='UPDATE' then old_value:=to_jsonb(old)->>tg_argv[0];
    if value is not distinct from old_value then return new; end if;
  end if;
  if value is null then return new; end if;
  -- Acquire the existing category FK lock BEFORE the media lock. Otherwise an
  -- INSERT could hold media while waiting for a category DELETE holding its row.
  if tg_table_name='products' then
    if new.category_id is not null then
      perform 1 from public.categories where store_id=new.store_id and id=new.category_id for key share;
      if not found then raise exception using errcode='23503',message='Category unavailable'; end if;
    end if;
  end if;
  perform pg_advisory_xact_lock(721304,1);
  if value is not null and exists(select 1 from catalog_media.jobs j where j.retired_at is not null
    and (catalog_media.reference_key(value,tg_argv[0]='image_path') is null
      or catalog_media.reference_key(value,tg_argv[0]='image_path')=j.bucket || '/' || j.path)) then
    raise exception using errcode='23514',message='Image reference is retired; select a new upload';
  end if;
  return new;
end $$;
create function catalog_media.queue_previous() returns trigger
language plpgsql security definer set search_path='' as $$
declare previous text;
begin
  previous:=to_jsonb(old)->>tg_argv[0];
  if tg_op='DELETE' or previous is distinct from (to_jsonb(new)->>tg_argv[0]) then
    perform catalog_media.enqueue(old.store_id,tg_argv[1],old.id::text,previous);
  end if;
  return null;
end $$;

create trigger catalog_product_reference before insert or update of image_path on public.products
for each row execute function catalog_media.guard_reference('image_path');
create trigger catalog_category_reference before insert or update of image_url on public.categories
for each row execute function catalog_media.guard_reference('image_url');
create trigger catalog_service_reference before insert or update of image_url on public.services
for each row execute function catalog_media.guard_reference('image_url');
create trigger catalog_staff_reference before insert or update of image_url on public.staff
for each row execute function catalog_media.guard_reference('image_url');
create trigger catalog_product_previous after delete or update of image_path on public.products
for each row execute function catalog_media.queue_previous('image_path','product');
create trigger catalog_category_previous after delete or update of image_url on public.categories
for each row execute function catalog_media.queue_previous('image_url','category');

-- Restrictive policies cannot be OR-bypassed by old permissive bucket policies.
create policy catalog_no_client_file_delete on storage.objects as restrictive for delete to anon,authenticated
using(bucket_id not in ('product-images','category-images'));
-- Move/rename/upsert can otherwise bypass a DELETE-only restriction. Current
-- catalog uploads use unique paths and upsert=false, so they need INSERT only.
create policy catalog_no_client_file_update on storage.objects as restrictive for update to anon,authenticated
using(bucket_id not in ('product-images','category-images'))
with check(bucket_id not in ('product-images','category-images'));
-- AND with every permissive policy, including historical bucket-only INSERT/ALL.
-- Compare IDs as text: malformed UUIDs and bigint overflow never require a cast.
create policy catalog_no_anon_category_insert on storage.objects as restrictive for insert to anon
with check(bucket_id <> 'category-images');
create policy catalog_category_insert_owner on storage.objects as restrictive for insert to authenticated
with check(bucket_id <> 'category-images' or (
  auth.uid() is not null and exists (
    select 1 from public.categories c join public.stores s on s.id=c.store_id
    where s.owner_user_id=auth.uid() and (
      storage.objects.name ~ ('^' || s.id::text || '/' || c.id::text || '/[a-zA-Z0-9_-]+\.(webp|png|jpg|jpeg)$')
      or storage.objects.name ~ ('^' || s.id::text || '-[a-z0-9]+(-[a-z0-9]+)*/categories/' ||
        c.id::text || '-[a-z0-9]+(-[a-z0-9]+)*/[a-zA-Z0-9_-]+\.(webp|png|jpg|jpeg)$')
    )
  )
));
create function catalog_media.guard_object() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if new.bucket_id in ('product-images','category-images') then
    perform pg_advisory_xact_lock(721304,1);
    if exists(select 1 from catalog_media.jobs where bucket=new.bucket_id and path=new.name and retired_at is not null) then
      raise exception using errcode='23514',message='Retired image paths cannot be reused';
    end if;
  end if;
  return new;
end $$;
create trigger catalog_retired_object before insert or update on storage.objects
for each row execute function catalog_media.guard_object();

create function catalog_media.authorize(p_actor uuid,p_store bigint) returns void
language plpgsql security definer set search_path='' as $$
declare role_data jsonb;
begin
  perform 1 from public.stores where id=p_store and owner_user_id=p_actor for share;
  if not found then raise exception using errcode='42501',message='Catalog access denied'; end if;
  select raw_app_meta_data into role_data from auth.users where id=p_actor;
  if not found or jsonb_typeof(role_data) is distinct from 'object'
    or coalesce(role_data->>'global_role','') not in ('admin','super_admin') then
    raise exception using errcode='42501',message='Catalog access denied';
  end if;
end $$;

create function public.delete_catalog_entity(p_actor uuid,p_store bigint,p_kind text,p_id text,p_operation uuid)
returns jsonb language plpgsql security definer set search_path='' set row_security=off as $$
declare receipt catalog_media.operations; ref text; job uuid;
begin
  if p_actor is null or p_store is null or p_store<=0 or p_operation is null
    or p_kind is null or p_kind not in ('product','category') or p_id is null
    or (p_kind='product' and p_id !~ '^[1-9][0-9]{0,18}$')
    or (p_kind='category' and p_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
    raise exception using errcode='22023',message='Invalid catalog request';
  end if;
  perform catalog_media.authorize(p_actor,p_store);
  perform pg_advisory_xact_lock(hashtextextended(p_store::text || ':' || p_operation::text,721304));
  select * into receipt from catalog_media.operations where store_id=p_store and operation_id=p_operation;
  if found then
    if receipt.actor_id<>p_actor or receipt.kind<>p_kind or receipt.entity_id<>p_id then
      raise exception using errcode='23505',message='Catalog operation conflict'; end if;
    return jsonb_build_object('deleted',true,'replayed',true,'cleanup',receipt.cleanup,'job_id',receipt.job_id);
  end if;
  if p_kind='product' then
    select image_path into ref from public.products where store_id=p_store and id::text=p_id for update;
    if not found then raise exception using errcode='P0002',message='Catalog record unavailable'; end if;
    delete from public.products where store_id=p_store and id::text=p_id;
  else
    select image_url into ref from public.categories where store_id=p_store and id::text=p_id for update;
    if not found then raise exception using errcode='P0002',message='Catalog record unavailable'; end if;
    if exists(select 1 from public.products where category_id::text=p_id) then
      raise exception using errcode='23503',message='Category has products'; end if;
    delete from public.categories where store_id=p_store and id::text=p_id;
  end if;
  job:=catalog_media.enqueue(p_store,p_kind,p_id,ref);
  insert into catalog_media.operations values(p_store,p_operation,p_actor,p_kind,p_id,job,
    case when ref is null then 'no_image' when job is null then 'retained_unverified' else 'pending' end)
    returning * into receipt;
  return jsonb_build_object('deleted',true,'replayed',false,'cleanup',receipt.cleanup,'job_id',job);
end $$;

create function public.claim_catalog_image_cleanup(p_actor uuid,p_store bigint,p_job uuid,p_origin text)
returns jsonb language plpgsql security definer set search_path='' set row_security=off as $$
declare j catalog_media.jobs; shared boolean;
begin
  perform catalog_media.authorize(p_actor,p_store);
  if p_origin is null or not exists(select 1 from catalog_media.settings where singleton and storage_base_url=p_origin) then
    raise exception using errcode='22023',message='Catalog Storage origin is not configured for this backend'; end if;
  perform pg_advisory_xact_lock(721304,1);
  select * into j from catalog_media.jobs where id=p_job and store_id=p_store for update;
  if not found then raise exception using errcode='42501',message='Catalog access denied'; end if;
  if j.state='deleted' then return jsonb_build_object('acquired',false,'state','deleted'); end if;
  if j.state='deleting' and j.claimed_at>clock_timestamp()-interval '2 minutes' then
    return jsonb_build_object('acquired',false,'state','deleting'); end if;
  -- The repository defines Commerce as the exact direct products projection in
  -- 202610100001. Only that reviewed view proves relative paths use product-images
  -- and reference publication is covered by the products media lock/retirement guard.
  -- An independent table/materialized/changed view may have other writers/buckets:
  -- retain ALL candidates, even if currently empty, rather than race those writers.
  -- pg_get_viewdef rendering differences also fail closed; review, never auto-approve.
  -- Production signature independently confirmed by the operator: same direct
  -- products.image_path projection; only pricing/offer expressions are derived.
  if not exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname='kafka_commerce_products'
      and case when c.relkind='v' then md5(pg_get_viewdef(c.oid,true)) in (
        'b90b085818ea02f9dfe71143dd81492b',
        '2a6cd6a7bcdf87c59984816f26c429a8')
        else false end) then
    update catalog_media.jobs set state='retained_shared',claimed_at=clock_timestamp() where id=j.id;
    return jsonb_build_object('acquired',false,'state','retained_shared');
  end if;
  select exists(select 1 from (
    select image_path as value,true as relative from public.products union all select image_url,false from public.categories
    union all select image_url,false from public.services union all select image_url,false from public.staff
    union all select image_path,true from public.kafka_commerce_products
  ) refs where value is not null and (catalog_media.reference_key(value,relative) is null or
    catalog_media.reference_key(value,relative)=j.bucket || '/' || j.path)) into shared;
  if shared then
    update catalog_media.jobs set state='retained_shared',claimed_at=clock_timestamp() where id=j.id;
    return jsonb_build_object('acquired',false,'state','retained_shared');
  end if;
  update catalog_media.jobs set state='deleting',retired_at=coalesce(retired_at,clock_timestamp()),
    claimed_at=clock_timestamp(),claim_token=gen_random_uuid() where id=j.id returning * into j;
  return jsonb_build_object('acquired',true,'state','deleting','bucket',j.bucket,'path',j.path,'claim_token',j.claim_token);
end $$;

create function public.finish_catalog_image_cleanup(p_actor uuid,p_store bigint,p_job uuid,p_claim uuid,p_success boolean)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  perform catalog_media.authorize(p_actor,p_store);
  update catalog_media.jobs set state=case when p_success then 'deleted' else 'failed' end
    where id=p_job and store_id=p_store and claim_token=p_claim and state='deleting';
  return found;
end $$;

create function public.catalog_image_cleanup_jobs(p_actor uuid,p_store bigint,p_kind text,p_id text)
returns setof uuid language plpgsql security definer set search_path='' as $$
begin
  perform catalog_media.authorize(p_actor,p_store);
  return query select id from catalog_media.jobs where store_id=p_store and kind=p_kind and entity_id=p_id
    and state<>'deleted'
    order by (case state when 'pending' then 0 when 'failed' then 1 when 'deleting' then 2 else 3 end),
      claimed_at nulls first,id limit 6;
end $$;

revoke delete on public.products, public.categories from public,anon,authenticated;
revoke all on all functions in schema catalog_media from public,anon,authenticated,service_role;
revoke all on function public.delete_catalog_entity(uuid,bigint,text,text,uuid),
  public.claim_catalog_image_cleanup(uuid,bigint,uuid,text),public.finish_catalog_image_cleanup(uuid,bigint,uuid,uuid,boolean),
  public.catalog_image_cleanup_jobs(uuid,bigint,text,text) from public,anon,authenticated;
grant execute on function public.delete_catalog_entity(uuid,bigint,text,text,uuid),
  public.claim_catalog_image_cleanup(uuid,bigint,uuid,text),public.finish_catalog_image_cleanup(uuid,bigint,uuid,uuid,boolean),
  public.catalog_image_cleanup_jobs(uuid,bigint,text,text) to service_role;
do $$
declare r text; f text;
begin
  foreach r in array array['anon','authenticated'] loop
    if has_table_privilege(r,'public.products','DELETE') or has_table_privilege(r,'public.categories','DELETE') then
      raise exception 'Unexpected inherited client DELETE grant; review role memberships'; end if;
    foreach f in array array['public.delete_catalog_entity(uuid,bigint,text,text,uuid)',
      'public.claim_catalog_image_cleanup(uuid,bigint,uuid,text)',
      'public.finish_catalog_image_cleanup(uuid,bigint,uuid,uuid,boolean)',
      'public.catalog_image_cleanup_jobs(uuid,bigint,text,text)'] loop
      if has_function_privilege(r,f,'EXECUTE') then
        raise exception 'Unexpected inherited client RPC grant; review role memberships'; end if;
    end loop;
  end loop;
end $$;
commit;
