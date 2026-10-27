-- READ ONLY. Run manually in Supabase SQL Editor and share this ONE result.
-- No rows/titles, credentials or file bytes are exported: only schema/security
-- definitions and aggregate counts. Do not replace this with a trigger-only query.
select jsonb_build_object(
  'columns',(select jsonb_agg(jsonb_build_object('table',table_name,'column',column_name,
      'type',data_type,'nullable',is_nullable,'default',column_default) order by table_name,ordinal_position)
    from information_schema.columns where table_schema='public' and table_name in ('publications','store_features')),
  'constraints',(select jsonb_agg(jsonb_build_object('name',conname,'validated',convalidated,
      'definition',pg_get_constraintdef(oid,true)) order by conname)
    from pg_constraint where conrelid='public.publications'::regclass),
  'triggers',(select jsonb_agg(jsonb_build_object('name',tgname,'trigger',pg_get_triggerdef(oid,true),
      'function',pg_get_functiondef(tgfoid)) order by tgname)
    from pg_trigger where tgrelid='public.publications'::regclass and not tgisinternal),
  'indexes',(select jsonb_agg(jsonb_build_object('name',indexname,'definition',indexdef) order by indexname)
    from pg_indexes where schemaname='public' and tablename='publications'),
  'rls',(select jsonb_agg(jsonb_build_object('table',relname,'rls',relrowsecurity,'force_rls',relforcerowsecurity,
      'table_acl',relacl::text) order by relname)
    from pg_class where oid in ('public.publications'::regclass,'public.store_features'::regclass,'storage.objects'::regclass)),
  'policies',(select jsonb_agg(to_jsonb(p) order by schemaname,tablename,policyname)
    from pg_policies p where (schemaname='public' and tablename in ('publications','store_features'))
      or (schemaname='storage' and tablename='objects')),
  'column_acls',(select jsonb_agg(jsonb_build_object('column',attname,'acl',attacl::text) order by attnum)
    from pg_attribute where attrelid='public.publications'::regclass and attnum>0 and not attisdropped),
  'bucket',(select jsonb_build_object('id',id,'public',public,'max_bytes',file_size_limit,'mime_types',allowed_mime_types)
    from storage.buckets where id='publication-files'),
  'module_enabled',pg_get_functiondef('kafka_modules.module_enabled(bigint,text)'::regprocedure),
  'can_manage',pg_get_functiondef('kafka_modules.can_manage(bigint,text)'::regprocedure),
  'global_role',pg_get_functiondef('kafka_modules.global_role()'::regprocedure),
  'type_and_status_counts',(select jsonb_agg(to_jsonb(c)) from
    (select publication_type,status,count(*) from public.publications group by publication_type,status order by publication_type,status)c),
  'duplicate_slugs',(select count(*) from
    (select store_id,slug from public.publications group by store_id,slug having count(*)>1)d),
  'dependent_views',(select jsonb_agg(distinct jsonb_build_object('schema',n.nspname,'name',v.relname,
      'definition',pg_get_viewdef(v.oid,true)))
    from pg_depend d join pg_rewrite r on r.oid=d.objid join pg_class v on v.oid=r.ev_class
    join pg_namespace n on n.oid=v.relnamespace
    where d.refobjid='public.publications'::regclass and d.classid='pg_rewrite'::regclass and v.relkind in ('v','m'))
) as publication_preflight;
