-- Step 4B. Review and apply manually as postgres; never run a frontend bootstrap.
-- Adopts the three EXISTING tables. Does not create/seed them or change catalog RPCs.
-- kafka_modules must NOT be an exposed Data API schema.
begin;

do $$
declare
  item record;
begin
  -- Only fields used by authorization and grants are assumed. Other defaults,
  -- timestamps and application constraints must be inspected before UI work.
  for item in select * from (values
    ('auth','users','id','uuid'), ('auth','users','raw_app_meta_data','jsonb'),
    ('public','stores','id','bigint'), ('public','stores','owner_user_id','uuid'),
    ('public','stores','name','string'), ('public','stores','slug','string'),
    ('public','store_features','store_id','bigint'),
    ('public','store_features','services_enabled','boolean'),
    ('public','store_features','staff_enabled','boolean'),
    ('public','store_features','commerce_enabled','boolean'),
    ('public','services','id','uuid'), ('public','services','store_id','bigint'),
    ('public','services','title','string'), ('public','services','description','string'),
    ('public','services','image_url','string'), ('public','services','sort_order','integer'),
    ('public','services','is_active','boolean'),
    ('public','staff','id','uuid'), ('public','staff','store_id','bigint'),
    ('public','staff','name','string'), ('public','staff','title','string'),
    ('public','staff','description','string'), ('public','staff','image_url','string'),
    ('public','staff','sort_order','integer'), ('public','staff','is_active','boolean')
  ) as required(schema_name, table_name, column_name, expected_type)
  loop
    if not exists (
      select 1 from information_schema.columns c
      where c.table_schema = item.schema_name and c.table_name = item.table_name
        and c.column_name = item.column_name
        and (c.data_type = item.expected_type or
          item.expected_type = 'string' and c.data_type in ('text','character varying'))
    ) then
      raise exception '4B: esquema incompatible; revisar %.%.%',
        item.schema_name, item.table_name, item.column_name;
    end if;
  end loop;

  if not exists (select 1 from pg_class c
    where c.oid = 'public.stores'::regclass and c.relrowsecurity) then
    raise exception '4B: stores debe conservar RLS habilitado';
  end if;
  if not has_table_privilege(current_user, 'auth.users', 'SELECT') or exists (
    select 1 from pg_class c where c.oid in (
      'public.stores'::regclass, 'public.store_features'::regclass)
      and not (c.relowner = current_user::regrole and not c.relforcerowsecurity)
      and not exists (select 1 from pg_roles r where r.rolname = current_user
        and (r.rolsuper or r.rolbypassrls))
  ) then
    raise exception '4B: aplicar con propietario confiable que pueda consultar Auth y evitar recursion RLS';
  end if;
  if exists (
    select 1 from pg_roles r where r.rolname in ('anon','authenticated') and (
      has_column_privilege(r.rolname, 'auth.users', 'raw_app_meta_data', 'UPDATE')
      or has_table_privilege(r.rolname, 'auth.users', 'INSERT,DELETE,TRUNCATE'))
  ) then
    raise exception '4B: permisos Auth inseguros; revisar antes de aplicar';
  end if;

  for item in select * from (values
    ('store_features','store_id'), ('services','id'), ('staff','id')
  ) as expected(table_name, primary_column)
  loop
    if not exists (
      select 1 from pg_constraint c join pg_attribute a
        on a.attrelid = c.conrelid and a.attname = item.primary_column
      where c.conrelid = to_regclass('public.' || item.table_name)
        and c.contype = 'p' and c.conkey = array[a.attnum]
    ) or not exists (
      select 1 from pg_constraint c
      join pg_attribute a on a.attrelid = c.conrelid and a.attname = 'store_id'
      join pg_attribute b on b.attrelid = c.confrelid and b.attname = 'id'
      where c.conrelid = to_regclass('public.' || item.table_name)
        and c.contype = 'f' and c.confrelid = 'public.stores'::regclass
        and c.conkey = array[a.attnum] and c.confkey = array[b.attnum]
        and c.convalidated
    ) then
      raise exception '4B: revisar PK/FK de public.%', item.table_name;
    end if;
  end loop;

  if exists (
    select 1 from pg_policies p where p.schemaname = 'public' and (
      p.tablename in ('store_features','services','staff')
      and (p.tablename,p.policyname) not in (
        ('store_features','kafka_4b_features_read'),('store_features','kafka_4b_features_manage'),
        ('services','kafka_4b_services_manage'),('services','kafka_4b_services_public'),
        ('staff','kafka_4b_staff_manage'),('staff','kafka_4b_staff_public'))
      or p.tablename = 'stores' and p.cmd in ('ALL','INSERT','UPDATE','DELETE')
        and p.policyname not in ('kafka_4b_stores_insert','kafka_4b_stores_update')
    )
  ) then
    raise exception '4B: politicas no previstas; revisar antes de aplicar';
  end if;
  -- A table-level REVOKE does not remove pre-existing column-level grants.
  if exists (
    select 1 from pg_attribute a cross join lateral aclexplode(a.attacl) acl
    where a.attrelid in ('public.store_features'::regclass,
      'public.services'::regclass,'public.staff'::regclass,'public.stores'::regclass)
      and acl.grantee in (0, 'anon'::regrole, 'authenticated'::regrole)
      and not (
        acl.grantee = 'authenticated'::regrole and acl.privilege_type = 'UPDATE' and not acl.is_grantable
        and (a.attrelid = 'public.store_features'::regclass
          and a.attname in ('services_enabled','staff_enabled','commerce_enabled')
          or a.attrelid = 'public.services'::regclass
          and a.attname in ('title','description','image_url','sort_order','is_active')
          or a.attrelid = 'public.staff'::regclass
          and a.attname in ('name','title','description','image_url','sort_order','is_active')
          or a.attrelid = 'public.stores'::regclass
          and a.attname in ('name','slug','owner_user_id'))
      )
  ) then
    raise exception '4B: grants por columna no previstos; revisar antes de aplicar';
  end if;
  if exists (select 1 from pg_namespace n where n.nspname = 'kafka_modules'
    and n.nspowner <> current_user::regrole) then
    raise exception '4B: revisar propietario del esquema auxiliar';
  end if;
end;
$$;

create schema if not exists kafka_modules;
revoke all on schema kafka_modules from public, anon, authenticated, service_role;
grant usage on schema kafka_modules to anon, authenticated;

create or replace function kafka_modules.global_role()
returns text language sql stable security definer set search_path = '' as $$
  select case
    when coalesce(u.raw_app_meta_data, '{}'::jsonb) ? 'global_role' then
      case when u.raw_app_meta_data->>'global_role' in ('super_admin','admin')
        then u.raw_app_meta_data->>'global_role' end
    -- Compatibility ONLY for an existing owner with an ABSENT key. Explicit
    -- null, unknown roles and user_metadata never fall back or elevate a user.
    when exists (select 1 from public.stores s where s.owner_user_id = u.id)
      then 'admin'
  end
  from auth.users u where u.id = auth.uid()
    and (u.raw_app_meta_data is null or jsonb_typeof(u.raw_app_meta_data) = 'object');
$$;

create or replace function kafka_modules.module_enabled(p_store_id bigint, p_module text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.store_features f join public.stores s on s.id = f.store_id
    where f.store_id = p_store_id and case p_module
      when 'services' then f.services_enabled
      when 'staff' then f.staff_enabled end is true
  );
$$;

create or replace function kafka_modules.can_manage(p_store_id bigint, p_module text)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(p_module in ('services','staff'), false) and exists (
    select 1 from public.stores s where s.id = p_store_id and (
      (select kafka_modules.global_role()) = 'super_admin' or (
        (select kafka_modules.global_role()) = 'admin' and s.owner_user_id = auth.uid()
        and kafka_modules.module_enabled(p_store_id, p_module)
      )
    )
  );
$$;

revoke all on function kafka_modules.global_role(),
  kafka_modules.module_enabled(bigint,text), kafka_modules.can_manage(bigint,text)
  from public, anon, authenticated, service_role;
grant execute on function kafka_modules.global_role(),
  kafka_modules.can_manage(bigint,text) to authenticated;
grant execute on function kafka_modules.module_enabled(bigint,text) to anon, authenticated;

alter table public.store_features enable row level security;
alter table public.services enable row level security;
alter table public.staff enable row level security;
revoke all on public.store_features, public.services, public.staff from public, anon, authenticated;
grant usage on schema public to anon, authenticated;
grant select, insert on public.store_features to authenticated;
grant update (services_enabled,staff_enabled,commerce_enabled) on public.store_features to authenticated;
grant select on public.services, public.staff to anon, authenticated;
grant insert, delete on public.services, public.staff to authenticated;
grant update (title,description,image_url,sort_order,is_active) on public.services to authenticated;
grant update (name,title,description,image_url,sort_order,is_active) on public.staff to authenticated;

drop policy if exists kafka_4b_features_read on public.store_features;
create policy kafka_4b_features_read on public.store_features for select to authenticated
using ((select kafka_modules.global_role()) = 'super_admin' or (
  (select kafka_modules.global_role()) = 'admin' and exists (
    select 1 from public.stores s where s.id = store_features.store_id
      and s.owner_user_id = auth.uid())));
drop policy if exists kafka_4b_features_manage on public.store_features;
create policy kafka_4b_features_manage on public.store_features for all to authenticated
using ((select kafka_modules.global_role()) = 'super_admin')
with check ((select kafka_modules.global_role()) = 'super_admin');

drop policy if exists kafka_4b_services_manage on public.services;
create policy kafka_4b_services_manage on public.services for all to authenticated
using (kafka_modules.can_manage(store_id,'services'))
with check (kafka_modules.can_manage(store_id,'services'));
drop policy if exists kafka_4b_services_public on public.services;
create policy kafka_4b_services_public on public.services for select to anon
using (is_active is true and kafka_modules.module_enabled(store_id,'services'));
drop policy if exists kafka_4b_staff_manage on public.staff;
create policy kafka_4b_staff_manage on public.staff for all to authenticated
using (kafka_modules.can_manage(store_id,'staff'))
with check (kafka_modules.can_manage(store_id,'staff'));
drop policy if exists kafka_4b_staff_public on public.staff;
create policy kafka_4b_staff_public on public.staff for select to anon
using (is_active is true and kafka_modules.module_enabled(store_id,'staff'));

-- Additive store management, never DELETE or changes to existing owner policies.
-- Catalog policies and RPCs remain owner-based; this does NOT grant a Super Admin
-- cross-tenant Commerce/payment privileges.
grant select, insert on public.stores to authenticated;
grant update (name,slug,owner_user_id) on public.stores to authenticated;
drop policy if exists kafka_4b_stores_read on public.stores;
create policy kafka_4b_stores_read on public.stores for select to authenticated
using ((select kafka_modules.global_role()) = 'super_admin');
drop policy if exists kafka_4b_stores_insert on public.stores;
create policy kafka_4b_stores_insert on public.stores for insert to authenticated
with check ((select kafka_modules.global_role()) = 'super_admin');
drop policy if exists kafka_4b_stores_update on public.stores;
create policy kafka_4b_stores_update on public.stores for update to authenticated
using ((select kafka_modules.global_role()) = 'super_admin')
with check ((select kafka_modules.global_role()) = 'super_admin');

commit;
