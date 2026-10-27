-- Publications V1. Review/preflight first; apply manually as postgres/BYPASSRLS.
-- Reuses the EXISTING publications table and PRIVATE publication-files bucket.
-- Only existing-row change: publication_type 'pdf' -> 'document'. All other
-- values, identities, PDF paths and historical timestamps are preserved.
begin;
set local lock_timeout='5s';

do $$
declare item record; legacy_trigger record; type_att smallint; expression text;
begin
  if not exists(select 1 from pg_roles where rolname=current_user and (rolsuper or rolbypassrls)) then
    raise exception 'Publications: ejecutar como postgres/BYPASSRLS';
  end if;
  if to_regprocedure('kafka_modules.can_manage(bigint,text)') is null
    or to_regprocedure('kafka_modules.global_role()') is null then
    raise exception 'Publications: faltan las funciones del Paso 4B';
  end if;
  if exists(select 1 from pg_class where oid in ('public.stores'::regclass,'public.store_features'::regclass)
    and not relrowsecurity) then
    raise exception 'Publications: stores y store_features deben conservar RLS';
  end if;
  for item in select * from (values
    ('id','uuid'),('store_id','bigint'),('title','text'),('slug','text'),('summary','text'),
    ('category','text'),('publication_type','text'),('content','text'),('pdf_storage_path','text'),
    ('pdf_original_name','text'),('pdf_size_bytes','bigint'),('cover_storage_path','text'),('status','text'),
    ('display_order','integer'),('published_at','timestamp with time zone'),('created_by','uuid'),
    ('created_at','timestamp with time zone'),('updated_at','timestamp with time zone')) v(name,kind)
  loop
    if not exists(select 1 from pg_attribute where attrelid=to_regclass('public.publications')
      and attname=item.name and not attisdropped and format_type(atttypid,atttypmod)=item.kind) then
      raise exception 'Publications: esquema incompatible en %; revisar preflight',item.name;
    end if;
  end loop;
  if not exists(select 1 from pg_class where oid='public.publications'::regclass and relkind='r' and not relispartition)
    or exists(select 1 from pg_inherits where inhparent='public.publications'::regclass or inhrelid='public.publications'::regclass) then
    raise exception 'Publications: tabla particionada/heredada requiere revision antes de convertir';
  end if;
  -- Freeze the inspected table until constraints/type/trigger are consolidated.
  -- Fail quickly on a busy database instead of holding a long deployment queue.
  lock table public.publications in access exclusive mode;
  if not exists(select 1 from pg_constraint where conrelid='public.publications'::regclass
      and contype='p' and conkey=array[(select attnum from pg_attribute where attrelid='public.publications'::regclass and attname='id')])
    or not exists(select 1 from pg_constraint where conrelid='public.publications'::regclass
      and confrelid='public.stores'::regclass and contype='f' and convalidated
      and conkey=array[(select attnum from pg_attribute where attrelid='public.publications'::regclass and attname='store_id')]
      and confkey=array[(select attnum from pg_attribute where attrelid='public.stores'::regclass and attname='id')]) then
    raise exception 'Publications: revisar PK UUID y FK store_id hacia stores.id';
  end if;
  if exists(select 1 from pg_trigger where tgrelid='public.publications'::regclass
    and not tgisinternal and tgname not in ('kafka_publications_validate','trg_publications_updated_at')) then
    raise exception 'Publications: triggers existentes requieren revision antes de aplicar';
  end if;
  select t.*,p.prosrc,p.prosecdef,p.prorettype,p.pronargs,p.proconfig,l.lanname,n.nspname,p.proname
    into legacy_trigger from pg_trigger t join pg_proc p on p.oid=t.tgfoid
    join pg_namespace n on n.oid=p.pronamespace join pg_language l on l.oid=p.prolang
    where t.tgrelid='public.publications'::regclass and t.tgname='trg_publications_updated_at' and not t.tgisinternal;
  if found then
    -- This exact timestamp-only body was supplied from remote preflight.
    -- Do not remove an unknown trigger simply because its name matches.
    if legacy_trigger.tgtype<>19 or legacy_trigger.tgenabled<>'O'
      or legacy_trigger.tgnargs<>0 or legacy_trigger.tgqual is not null
      or legacy_trigger.tgattr::text<>'' or legacy_trigger.tgconstraint<>0
      or legacy_trigger.nspname<>'public' or legacy_trigger.proname<>'set_publications_updated_at'
      or legacy_trigger.lanname<>'plpgsql' or legacy_trigger.prosecdef
      or legacy_trigger.prorettype<>'trigger'::regtype or legacy_trigger.pronargs<>0
      or legacy_trigger.proconfig is distinct from array['search_path=""']::text[]
      or regexp_replace(lower(legacy_trigger.prosrc),'[[:space:]]','','g')
        not in ('beginnew.updated_at=now();returnnew;end;','beginnew.updated_at:=now();returnnew;end;') then
      raise exception 'Publications: trigger updated_at no coincide con la definicion verificada';
    end if;
  end if;
  if exists(select 1 from pg_trigger where tgrelid='public.publications'::regclass
    and tgname='kafka_publications_validate' and not tgisinternal
    and tgfoid is distinct from to_regprocedure('kafka_modules.validate_publication()')) then
    raise exception 'Publications: trigger de validacion existente desconocido';
  end if;
  select attnum into type_att from pg_attribute
    where attrelid='public.publications'::regclass and attname='publication_type';
  if exists(select 1 from pg_constraint where contype='f' and (
    (conrelid='public.publications'::regclass and type_att=any(conkey)) or
    (confrelid='public.publications'::regclass and type_att=any(confkey)))) then
    raise exception 'Publications: FK dependiente del tipo; revisar antes de convertir, sin CASCADE';
  end if;
  if exists(select 1 from pg_rewrite where ev_class='public.publications'::regclass) then
    raise exception 'Publications: reglas existentes requieren revision antes de convertir';
  end if;
  for item in select conname,conkey,pg_get_expr(conbin,conrelid) as definition
    from pg_constraint where conrelid='public.publications'::regclass and contype='c'
      and type_att=any(conkey) and conname<>'kafka_publications_fields'
  loop
    expression := regexp_replace(lower(item.definition),'[[:space:]]','','g');
    if item.conkey is distinct from array[type_att] or expression not in (
      '(publication_type=any(array[''pdf''::text,''article''::text]))',
      '(publication_type=any(array[''article''::text,''pdf''::text]))',
      '(publication_type=any(array[''document''::text,''article''::text]))',
      '(publication_type=any(array[''article''::text,''document''::text]))',
      '((publication_type=''pdf''::text)or(publication_type=''article''::text))',
      '((publication_type=''article''::text)or(publication_type=''pdf''::text))',
      '((publication_type=''document''::text)or(publication_type=''article''::text))',
      '((publication_type=''article''::text)or(publication_type=''document''::text))'
    ) then
      raise exception 'Publications: CHECK de tipo no reconocido: %. Revisar preflight',item.conname;
    end if;
  end loop;
  select pg_get_expr(d.adbin,d.adrelid) into expression from pg_attrdef d
    where d.adrelid='public.publications'::regclass and d.adnum=type_att;
  if expression is not null and expression not in ('''pdf''::text','''document''::text','''article''::text') then
    raise exception 'Publications: default de publication_type no reconocido';
  end if;
  if exists(select 1 from public.publications where publication_type is null
      or publication_type not in ('pdf','document','article')) then
    raise exception 'Publications: valores de tipo desconocidos; no se modificaron datos';
  end if;
  if exists(select 1 from pg_policy where polrelid='public.publications'::regclass
    and (coalesce(pg_get_expr(polqual,polrelid),'')||coalesce(pg_get_expr(polwithcheck,polrelid),'')) like '%''pdf''%') then
    raise exception 'Publications: politica dependiente del literal pdf; revisar antes de migrar';
  end if;
  if exists(select 1 from pg_depend d join pg_rewrite r on r.oid=d.objid
    join pg_class v on v.oid=r.ev_class where d.refobjid='public.publications'::regclass
    and d.classid='pg_rewrite'::regclass and v.relkind in ('v','m')
    and pg_get_viewdef(v.oid,true) like '%''pdf''%') then
    raise exception 'Publications: vista dependiente del literal pdf; revisar su contrato sin modificarla';
  end if;
  if exists(select 1 from pg_policies where schemaname='public' and tablename='store_features'
      and policyname not in ('kafka_4b_features_read','kafka_4b_features_manage',
        'kafka_publications_features_insert','kafka_publications_features_update','kafka_publications_features_delete'))
    or not exists(select 1 from pg_policies where schemaname='public' and tablename='store_features'
      and policyname='kafka_4b_features_manage' and cmd='ALL') then
    raise exception 'Publications: revisar politicas efectivas de store_features';
  end if;
  if exists(select 1 from pg_attribute where attrelid='public.publications'::regclass
    and attname in ('content','cover_storage_path','pdf_storage_path','pdf_original_name','pdf_size_bytes')
    and attnotnull and not atthasdef and not attisdropped) then
    raise exception 'Publications: revisar campos opcionales NOT NULL sin default';
  end if;
  if not exists(select 1 from storage.buckets where id='publication-files' and public is false
    and file_size_limit=10485760 and allowed_mime_types=array['application/pdf']::text[]) then
    raise exception 'Publications: bucket existente debe ser privado, PDF, 10 MB';
  end if;
  if not exists(select 1 from pg_class where oid='storage.objects'::regclass and relrowsecurity) then
    raise exception 'Publications: Storage debe conservar RLS';
  end if;
end $$;

-- Consolidate only the verified legacy trigger. Keep its FUNCTION untouched: it
-- may be referenced elsewhere. Neither timestamp trigger runs for the type UPDATE.
drop trigger if exists trg_publications_updated_at on public.publications;
drop trigger if exists kafka_publications_validate on public.publications;
do $$ declare item record; type_att smallint; old_default text; expected bigint; converted bigint;
begin
  select attnum into type_att from pg_attribute
    where attrelid='public.publications'::regclass and attname='publication_type';
  -- The preceding preflight validated every CHECK selected here, independently
  -- of its name. No CASCADE and no unrelated constraints are removed.
  for item in select conname from pg_constraint where conrelid='public.publications'::regclass
    and contype='c' and type_att=any(conkey) and conname<>'kafka_publications_fields'
  loop
    execute format('alter table public.publications drop constraint %I',item.conname);
  end loop;
  select pg_get_expr(d.adbin,d.adrelid) into old_default from pg_attrdef d
    where d.adrelid='public.publications'::regclass and d.adnum=type_att;
  if old_default='''pdf''::text' then
    alter table public.publications alter column publication_type set default 'document';
  end if;
  select count(*) into expected from public.publications where publication_type='pdf';
  update public.publications set publication_type='document' where publication_type='pdf';
  get diagnostics converted=row_count;
  if converted<>expected then raise exception 'Publications: conversion incompleta; rollback requerido'; end if;
  raise notice 'Publications: % filas convertidas de pdf a document',converted;
end $$;

alter table public.store_features add column if not exists publications_enabled boolean default false;
do $$ begin
  if not exists(select 1 from pg_attribute where attrelid='public.store_features'::regclass
    and attname='publications_enabled' and atttypid='boolean'::regtype and not attisdropped) then
    raise exception 'Publications: publications_enabled debe ser boolean';
  end if;
end $$;
grant update(publications_enabled) on public.store_features to authenticated;
drop policy if exists kafka_publications_features_insert on public.store_features;
create policy kafka_publications_features_insert on public.store_features as restrictive for insert to authenticated
with check((select kafka_modules.global_role())='super_admin');
drop policy if exists kafka_publications_features_update on public.store_features;
create policy kafka_publications_features_update on public.store_features as restrictive for update to authenticated
using((select kafka_modules.global_role())='super_admin') with check((select kafka_modules.global_role())='super_admin');
drop policy if exists kafka_publications_features_delete on public.store_features;
create policy kafka_publications_features_delete on public.store_features as restrictive for delete to authenticated
using((select kafka_modules.global_role())='super_admin');

-- Same 4B semantics; the only extension is the publications allowlist/flag.
create or replace function kafka_modules.module_enabled(p_store_id bigint,p_module text)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.store_features f join public.stores s on s.id=f.store_id
    where f.store_id=p_store_id and case p_module
      when 'services' then f.services_enabled when 'staff' then f.staff_enabled
      when 'publications' then f.publications_enabled end is true);
$$;
create or replace function kafka_modules.can_manage(p_store_id bigint,p_module text)
returns boolean language sql stable security definer set search_path='' as $$
  select coalesce(p_module in ('services','staff','publications'),false) and exists(
    select 1 from public.stores s where s.id=p_store_id and (
      (select kafka_modules.global_role())='super_admin' or (
        (select kafka_modules.global_role())='admin' and s.owner_user_id=auth.uid()
        and kafka_modules.module_enabled(p_store_id,p_module))));
$$;
revoke all on function kafka_modules.module_enabled(bigint,text),kafka_modules.can_manage(bigint,text)
  from public,anon,authenticated,service_role;
grant execute on function kafka_modules.module_enabled(bigint,text) to anon,authenticated;
grant execute on function kafka_modules.can_manage(bigint,text) to authenticated;

create unique index if not exists kafka_publications_store_slug on public.publications(store_id,slug);
do $$ begin
  if not exists(select 1 from pg_index where indexrelid='public.kafka_publications_store_slug'::regclass
    and indrelid='public.publications'::regclass and indisunique and indisvalid and indpred is null
    and indnkeyatts=2 and indexprs is null and indkey::text=(
      select string_agg(attnum::text,' ' order by case attname when 'store_id' then 1 else 2 end)
      from pg_attribute where attrelid='public.publications'::regclass and attname in ('store_id','slug'))) then
    raise exception 'Publications: indice existente incompatible';
  end if;
  if not exists(select 1 from pg_constraint where conrelid='public.publications'::regclass and conname='kafka_publications_fields') then
    alter table public.publications add constraint kafka_publications_fields check (
      store_id is not null and title is not null and length(btrim(title)) between 1 and 200
      and slug is not null and length(slug) between 1 and 120 and slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
      and status is not null and status in ('draft','published','archived')
      and publication_type is not null and publication_type in ('document','article')
      and display_order is not null and coalesce(length(summary),0)<=5000 and coalesce(length(category),0)<=200
      and ((pdf_storage_path is null and pdf_original_name is null and pdf_size_bytes is null) or (
        pdf_storage_path is not null and pdf_original_name is not null and length(pdf_original_name) between 1 and 255
        and pdf_size_bytes is not null and pdf_size_bytes between 1 and 10485760))
      and (status<>'published' or publication_type<>'document' or pdf_storage_path is not null)
    ) not valid;
  end if;
end $$;
alter table public.publications validate constraint kafka_publications_fields;

create or replace function kafka_modules.publication_file_path(p_path text,p_store bigint,p_id uuid)
returns boolean language sql immutable set search_path='' as $$
  select coalesce(array_length(parts,1)=4 and parts[1] ~ '^[1-9][0-9]*-[a-z0-9]+(-[a-z0-9]+)*$'
    and split_part(parts[1],'-',1)=p_store::text and parts[2]='publications'
    and left(parts[3],36)=p_id::text
    and parts[3] ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}-[a-z0-9]+(-[a-z0-9]+)*$'
    and parts[4] ~ '^documento-[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}\.pdf$',false)
  from (select string_to_array(p_path,'/') parts) p;
$$;
create or replace function kafka_modules.can_manage_publication_file(p_name text)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.publications p where
    kafka_modules.publication_file_path(p_name,p.store_id,p.id) and kafka_modules.can_manage(p.store_id,'publications'));
$$;

create or replace function kafka_modules.validate_publication()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if tg_op='INSERT' then
    new.created_by := coalesce(auth.uid(),new.created_by);
    new.created_at := clock_timestamp();
    -- Clients cannot inject a publishing timestamp via INSERT.
    new.published_at := case when new.status='published' then clock_timestamp() else null end;
  else
    new.created_by := old.created_by; new.created_at := old.created_at;
    new.published_at := coalesce(old.published_at,case when new.status='published' then clock_timestamp() end);
  end if;
  new.updated_at := clock_timestamp();
  if new.pdf_storage_path is not null then
    if not kafka_modules.publication_file_path(new.pdf_storage_path,new.store_id,new.id) then
      raise exception using errcode='22023',message='Referencia PDF no valida';
    end if;
    if (tg_op='INSERT' or new.pdf_storage_path is distinct from old.pdf_storage_path or new.status='published')
      and not exists(select 1 from storage.objects o where o.bucket_id='publication-files' and o.name=new.pdf_storage_path) then
      raise exception using errcode='22023',message='PDF no disponible en Storage';
    end if;
  end if;
  return new;
end $$;
revoke all on function kafka_modules.publication_file_path(text,bigint,uuid),
  kafka_modules.can_manage_publication_file(text),kafka_modules.validate_publication()
  from public,anon,authenticated,service_role;
grant execute on function kafka_modules.can_manage_publication_file(text) to authenticated;
drop trigger if exists kafka_publications_validate on public.publications;
create trigger kafka_publications_validate before insert or update on public.publications
  for each row execute function kafka_modules.validate_publication();

alter table public.publications enable row level security;
revoke all on public.publications from public,anon,authenticated;
-- Revoke historical column ACLs too; a table-level REVOKE alone is insufficient.
do $$ declare cols text; begin
  select string_agg(quote_ident(attname),',') into cols from pg_attribute
    where attrelid='public.publications'::regclass and attnum>0 and not attisdropped;
  execute format('revoke select (%s),insert (%s),update (%s),references (%s) on public.publications from public,anon,authenticated',cols,cols,cols,cols);
end $$;
grant select,delete on public.publications to authenticated;
grant insert(id,store_id,title,slug,summary,category,publication_type,status,display_order) on public.publications to authenticated;
grant update(title,slug,summary,category,publication_type,status,display_order,pdf_storage_path,pdf_original_name,pdf_size_bytes) on public.publications to authenticated;
grant select(id,store_id,title,slug,summary,category,publication_type,display_order,published_at,status) on public.publications to anon;

drop policy if exists kafka_publications_manage on public.publications;
create policy kafka_publications_manage on public.publications for all to authenticated
using(kafka_modules.can_manage(store_id,'publications')) with check(kafka_modules.can_manage(store_id,'publications'));
drop policy if exists kafka_publications_manage_guard on public.publications;
create policy kafka_publications_manage_guard on public.publications as restrictive for all to authenticated
using(kafka_modules.can_manage(store_id,'publications')) with check(kafka_modules.can_manage(store_id,'publications'));
drop policy if exists kafka_publications_read on public.publications;
create policy kafka_publications_read on public.publications for select to anon
using(status='published' and kafka_modules.module_enabled(store_id,'publications'));
drop policy if exists kafka_publications_public_guard on public.publications;
create policy kafka_publications_public_guard on public.publications as restrictive for all to anon
using(status='published' and kafka_modules.module_enabled(store_id,'publications')) with check(false);

-- Restrictive policies constrain even legacy bucket-only or global permissive
-- policies, without changing their behavior for any OTHER bucket.
drop policy if exists kafka_publications_files_read on storage.objects;
create policy kafka_publications_files_read on storage.objects for select to authenticated
using(bucket_id='publication-files' and kafka_modules.can_manage_publication_file(name));
drop policy if exists kafka_publications_files_insert on storage.objects;
create policy kafka_publications_files_insert on storage.objects for insert to authenticated
with check(bucket_id='publication-files' and kafka_modules.can_manage_publication_file(name));
drop policy if exists kafka_publications_files_guard on storage.objects;
create policy kafka_publications_files_guard on storage.objects as restrictive for all to authenticated
using(bucket_id<>'publication-files' or kafka_modules.can_manage_publication_file(name))
with check(bucket_id<>'publication-files' or kafka_modules.can_manage_publication_file(name));
drop policy if exists kafka_publications_files_no_anon on storage.objects;
create policy kafka_publications_files_no_anon on storage.objects as restrictive for all to anon
using(bucket_id<>'publication-files') with check(bucket_id<>'publication-files');
drop policy if exists kafka_publications_files_no_update on storage.objects;
create policy kafka_publications_files_no_update on storage.objects as restrictive for update to authenticated
using(bucket_id<>'publication-files') with check(bucket_id<>'publication-files');
drop policy if exists kafka_publications_files_no_delete on storage.objects;
create policy kafka_publications_files_no_delete on storage.objects as restrictive for delete to authenticated
using(bucket_id<>'publication-files');
commit;
