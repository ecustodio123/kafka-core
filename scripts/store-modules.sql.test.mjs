import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const bin = process.env.CATALOG_PG_BIN ??
  (existsSync('/opt/homebrew/opt/postgresql@16/bin/initdb') ? '/opt/homebrew/opt/postgresql@16/bin' : null);
const exe = (name) => bin ? join(bin, name) : name;
const read = (file) => readFileSync(new URL(`../supabase/${file}`, import.meta.url), 'utf8');
const migration = read('migrations/202610200001_store_modules_security.sql');
const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const superAdmin = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const outsider = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const invalid = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const spoof = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const auth = (id = owner) => `set role authenticated; set request.jwt.claim.sub='${id}';`;
const service = '10000000-0000-4000-8000-000000000001';
const staff = '20000000-0000-4000-8000-000000000002';

test('step 4B: real isolated PostgreSQL authorization, no remote DB and no skips', async (t) => {
  for (const tool of ['initdb', 'pg_ctl', 'psql']) {
    assert.equal(spawnSync(exe(tool), ['--version'], { stdio: 'ignore' }).status, 0, `${tool} required; no skips`);
  }
  const root = mkdtempSync(join(tmpdir(), 'kafka-modules-'));
  const data = join(root, 'data');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PG')));
  const args = ['-X', '-q', '-At', '-h', root, '-p', '55451', '-U', 'modules_test', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'];
  let started = false;
  function run(cmd, argv, source) {
    const r = spawnSync(exe(cmd), argv, { input: source, env, encoding: 'utf8', timeout: 30000 });
    assert.equal(r.status, 0, r.stderr || `${cmd} failed`);
    return r.stdout.trim();
  }
  const query = (sql) => run('psql', args, sql);
  const check = (sql) => query(`begin; ${sql}; rollback;`);
  function fails(sql, pattern = /permission denied|row-level security/) {
    const r = spawnSync(exe('psql'), args, { input: `begin; ${sql}`, env, encoding: 'utf8', timeout: 10000 });
    assert.notEqual(r.status, 0); assert.match(r.stderr, pattern);
  }
  const protectedCatalog = () => query(`select jsonb_build_object(
    'policies',(select jsonb_agg(to_jsonb(p) order by p.tablename,p.policyname) from pg_policies p
      where p.schemaname='public' and p.tablename in ('products','categories')),
    'grants',(select jsonb_agg(jsonb_build_array(c.relname,c.relacl) order by c.relname)
      from pg_class c where c.oid in ('public.products'::regclass,'public.categories'::regclass,
        'public.kafka_commerce_products'::regclass)),
    'view',pg_get_viewdef('public.kafka_commerce_products'::regclass,true),
    'rpc',pg_get_functiondef('public.create_product_idempotent(bigint,uuid,jsonb)'::regprocedure),
    'columns',(select jsonb_agg(to_jsonb(c) order by c.table_name,c.ordinal_position)
      from information_schema.columns c where c.table_schema='public'
        and c.table_name in ('stores','products','categories','store_features','services','staff')));`);
  const rows = () => query(`select jsonb_build_object(
    'users',(select jsonb_agg(to_jsonb(u) order by id) from auth.users u),
    'stores',(select jsonb_agg(to_jsonb(s) order by id) from public.stores s),
    'features',(select jsonb_agg(to_jsonb(f) order by store_id) from public.store_features f),
    'services',(select jsonb_agg(to_jsonb(s) order by id) from public.services s),
    'staff',(select jsonb_agg(to_jsonb(s) order by id) from public.staff s));`);
  try {
    run('initdb', ['-D', data, '-U', 'modules_test', '-A', 'trust', '--no-locale']);
    run('pg_ctl', ['-D', data, '-l', join(root, 'server.log'), '-o', `-k ${root} -p 55451 -c listen_addresses=''`, '-w', 'start']);
    started = true;
    query(read('tests/product_creation.local.sql'));
    for (const file of ['phase-6-auth-rls.sql', 'migrations/202610080001_add_product_categories.sql',
      'migrations/202610100001_add_product_offers_rating.sql', 'migrations/202610160001_product_creation_idempotency.sql',
      'tests/store_modules.local.sql']) query(read(file));
    const before = protectedCatalog(); const beforeRows = rows();
    const beforeRoles = query('select rolname from pg_roles order by rolname;');
    query(migration);

    await t.test('migration preserves existing data, catalog policies/RPC/view, column contracts and roles', () => {
      assert.equal(protectedCatalog(), before); assert.equal(rows(), beforeRows);
      assert.equal(query('select rolname from pg_roles order by rolname;'), beforeRoles);
    });
    await t.test('missing role preserves ONLY existing owners; explicit admin/super_admin are recognized', () => {
      assert.equal(check(auth() + 'select kafka_modules.global_role()'), 'admin');
      assert.equal(check(auth(other) + 'select kafka_modules.global_role()'), 'admin');
      assert.equal(check(auth(superAdmin) + 'select kafka_modules.global_role()'), 'super_admin');
      assert.equal(check(`set request.jwt.claim.sub='${outsider}'; update auth.users set raw_app_meta_data='{}' where id='${outsider}';
        set role authenticated; select kafka_modules.global_role() is null`), 't');
    });
    await t.test('explicit null/unknown/malformed roles never fall back to owner status', () => {
      assert.equal(check(auth(invalid) + 'select kafka_modules.global_role() is null'), 't');
      for (const value of ['{"global_role":"owner"}', '{"global_role":""}', '[]']) {
        assert.equal(check(`update auth.users set raw_app_meta_data='${value}' where id='${owner}';
          ${auth()} select kafka_modules.global_role() is null`), 't');
      }
    });
    await t.test('user_metadata cannot elevate and ordinary clients cannot write trusted Auth metadata', () => {
      assert.equal(check(auth(spoof) + 'select kafka_modules.global_role()'), 'admin');
      assert.equal(check(auth(spoof) + 'select count(*) from public.store_features'), '1');
      fails(auth(spoof) + `update auth.users set raw_app_meta_data='{"global_role":"super_admin"}' where id='${spoof}'`);
    });
    await t.test('owner sees flags even when disabled, but never another tenant configuration', () => {
      assert.equal(check(auth() + 'select store_id from public.store_features order by store_id'), '1');
      assert.equal(check(auth(other) + 'select store_id from public.store_features'), '2');
      assert.equal(check(auth(outsider) + 'select count(*) from public.store_features'), '0');
    });
    await t.test('only Super Admin can insert/update flags; no client can delete or retarget a configuration', () => {
      assert.equal(check(auth() + 'update public.store_features set services_enabled=false where store_id=1 returning store_id'), '');
      fails(auth() + 'insert into public.store_features(store_id) values(3)');
      assert.equal(check(auth(superAdmin) + 'update public.store_features set services_enabled=false where store_id=1 returning store_id'), '1');
      assert.equal(check(auth(superAdmin) + 'insert into public.store_features(store_id) values(3) returning store_id'), '3');
      fails(auth(superAdmin) + 'delete from public.store_features where store_id=1');
      fails(auth(superAdmin) + 'update public.store_features set store_id=3 where store_id=1');
    });
    await t.test('enabled owners administer their active AND inactive services/staff only', () => {
      assert.equal(check(auth() + 'select count(*) from public.services'), '2');
      assert.equal(check(auth(other) + 'select count(*) from public.staff'), '2');
      assert.equal(check(auth() + `update public.services set title='EDIT' where id='${service}' returning title`), 'EDIT');
      assert.equal(check(auth(other) + `update public.staff set name='EDIT' where id='${staff}' returning name`), 'EDIT');
      assert.equal(check(auth() + `delete from public.services where id='${service}' returning id`), service);
      assert.equal(check(auth(other) + `delete from public.staff where id='${staff}' returning id`), staff);
      assert.equal(check(auth() + "insert into public.services(store_id,title) values(1,'LOCAL INSERT') returning title"), 'LOCAL INSERT');
      assert.equal(check(auth(other) + "insert into public.staff(store_id,name) values(2,'LOCAL INSERT') returning name"), 'LOCAL INSERT');
    });
    await t.test('confirmed UUID/bigint schema and TRUE/zero defaults are honored by real inserts', () => {
      for (const [table, field, storeId, user] of [
        ['services', 'title', 1, owner], ['staff', 'name', 2, other],
      ]) {
        const row = JSON.parse(check(auth(user) + `insert into public.${table}(store_id,${field})
          values(${storeId},'LOCAL DEFAULT') returning jsonb_build_object(
            'id',id,'id_type',pg_typeof(id)::text,'store_id',store_id,
            'store_type',pg_typeof(store_id)::text,'sort_order',sort_order,'is_active',is_active)`));
        assert.match(row.id, /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/);
        assert.equal(row.id_type, 'uuid'); assert.equal(row.store_type, 'bigint');
        assert.equal(row.store_id, storeId); assert.equal(row.sort_order, 0); assert.equal(row.is_active, true);
        assert.equal(check(auth(user) + `insert into public.${table}(store_id,${field})
          values(${storeId},'LOCAL DEFAULT PUBLIC'); reset role; set role anon;
          select count(*) from public.${table} where ${field}='LOCAL DEFAULT PUBLIC'`), '1');
        assert.equal(check(auth(user) + `insert into public.${table}(store_id,${field},is_active)
          values(${storeId},'LOCAL EXPLICIT DRAFT',false); reset role; set role anon;
          select count(*) from public.${table} where ${field}='LOCAL EXPLICIT DRAFT'`), '0');
      }
    });
    await t.test('disabled modules deny direct reads, inserts, updates and deletes even for the owner', () => {
      assert.equal(check(auth() + 'select count(*) from public.staff'), '0');
      assert.equal(check(auth(other) + 'select count(*) from public.services'), '0');
      fails(auth() + "insert into public.staff(store_id,name) values(1,'DENIED')");
      fails(auth(other) + "insert into public.services(store_id,title) values(2,'DENIED')");
      assert.equal(check(auth() + "update public.staff set name='DENIED' where store_id=1 returning id"), '');
      assert.equal(check(auth(other) + 'delete from public.services where store_id=2 returning id'), '');
    });
    await t.test('missing configuration, NULL flags and unknown modules fail closed', () => {
      assert.equal(check(auth() + "select kafka_modules.can_manage(3,'services')"), 'f');
      assert.equal(check(auth(spoof) + "select kafka_modules.can_manage(5,'staff')"), 'f');
      assert.equal(check(auth(superAdmin) + "select kafka_modules.can_manage(1,'commerce')"), 'f');
      assert.equal(check(auth(superAdmin) + 'select kafka_modules.can_manage(1,null)'), 'f');
      fails(auth() + "insert into public.services(store_id,title) values(3,'DENIED')");
      assert.equal(check("set role anon; select kafka_modules.module_enabled(3,'services'), kafka_modules.module_enabled(5,'staff')"), 'f|f');
    });
    await t.test('cross-tenant insert/update/delete and row identity changes are denied', () => {
      fails(auth(other) + "insert into public.services(store_id,title) values(1,'DENIED')");
      assert.equal(check(auth(outsider) + `update public.services set title='DENIED' where id='${service}' returning id`), '');
      assert.equal(check(auth(outsider) + `delete from public.staff where id='${staff}' returning id`), '');
      fails(auth() + `update public.services set store_id=3 where id='${service}'`);
      fails(auth() + `update public.services set id=gen_random_uuid() where id='${service}'`);
    });
    await t.test('Super Admin can maintain all new content, including disabled/unconfigured stores', () => {
      assert.equal(check(auth(superAdmin) + 'select count(*) from public.services'), '3');
      assert.equal(check(auth(superAdmin) + 'select count(*) from public.staff'), '3');
      assert.equal(check(auth(superAdmin) + "insert into public.services(store_id,title) values(3,'MAINTENANCE') returning title"), 'MAINTENANCE');
      assert.equal(check(auth(superAdmin) + `update public.staff set title='MAINTENANCE' where id='${staff}' returning title`), 'MAINTENANCE');
    });
    await t.test('anonymous reads require both active content and enabled module; flags/stores stay private', () => {
      assert.equal(check('set role anon; select title from public.services'), 'LOCAL PUBLIC SERVICE');
      assert.equal(check('set role anon; select name from public.staff'), 'LOCAL PUBLIC STAFF');
      fails('set role anon; select * from public.store_features');
      fails('set role anon; select * from public.stores');
    });
    await t.test('public visibility disappears when configuration is missing/NULL or publication is NULL', () => {
      assert.equal(check('delete from public.store_features where store_id=1; set role anon; select count(*) from public.services'), '0');
      assert.equal(check('update public.store_features set staff_enabled=null where store_id=2; set role anon; select count(*) from public.staff'), '0');
      assert.equal(check(`update public.services set is_active=null where id='${service}'; set role anon; select count(*) from public.services`), '0');
    });
    await t.test('anonymous writes, truncate and helper privilege escalation are denied', () => {
      fails("set role anon; insert into public.services(store_id,title) values(1,'DENIED')");
      fails("set role anon; update public.staff set name='DENIED'");
      fails('set role anon; delete from public.services');
      fails(auth(superAdmin) + 'truncate public.staff');
      fails('set role anon; select kafka_modules.global_role()');
      fails("set role anon; select kafka_modules.can_manage(1,'services')");
      fails(auth() + 'create function kafka_modules.attack() returns int language sql as $$ select 1 $$');
    });
    await t.test('role revocation and flag changes apply to the next statement without refreshing a JWT', () => {
      assert.equal(check(auth(superAdmin) + `select kafka_modules.global_role(); reset role;
        update auth.users set raw_app_meta_data='{"global_role":null}' where id='${superAdmin}';
        set role authenticated; select kafka_modules.global_role() is null`), 'super_admin\nt');
      assert.equal(check(auth() + `select count(*) from public.services; reset role;
        update public.store_features set services_enabled=false where store_id=1;
        set role authenticated; select count(*) from public.services`), '2\n0');
    });
    await t.test('Super Admin manages stores, Admin cannot reassign ownership or create stores', () => {
      assert.equal(check(auth(superAdmin) + 'select count(*) from public.stores'), '5');
      assert.equal(check(auth(superAdmin) + `update public.stores set owner_user_id='${other}' where id=1 returning id`), '1');
      assert.equal(check(auth(superAdmin) + "insert into public.stores(name,slug) values('LOCAL NEW','local-new') returning name"), 'LOCAL NEW');
      assert.equal(check(auth() + `update public.stores set owner_user_id='${other}' where id=1 returning id`), '');
      fails(auth() + "insert into public.stores(name,slug) values('DENIED','denied')");
      fails(auth(superAdmin) + 'delete from public.stores where id=3');
    });
    await t.test('table-level store INSERT/UPDATE grants never bypass Super Admin RLS', () => {
      for (const user of [owner, other]) {
        assert.equal(check(`grant insert,update on public.stores to public;
          ${auth(user)} update public.stores set owner_user_id='${outsider}'
          where owner_user_id='${user}' returning id`), '');
        fails(`grant insert,update on public.stores to public; ${auth(user)}
          insert into public.stores(name,slug,owner_user_id) values('DENIED','denied','${user}')`);
      }
    });
    await t.test('ownership transfer revokes the old owner access to new modules', () => {
      assert.equal(check(auth(superAdmin) + `update public.stores set owner_user_id='${other}' where id=1;
        reset role; ${auth()} select count(*) from public.services`), '0');
    });
    await t.test('legacy catalog creation stays owner-only and commerce_enabled does not silently change it', () => {
      const input = JSON.stringify({ name: 'LOCAL COMPATIBILITY', description: '', price: 20,
        discount_active: false, discount_price: null, visual_rating: 5, category_id: null, available: true });
      const rpc = `select public.create_product_idempotent(1,'30000000-0000-4000-8000-000000000001','${input}'::jsonb)`;
      const result = JSON.parse(check(`update public.store_features set commerce_enabled=false where store_id=1;
        ${auth()} ${rpc}`));
      assert.equal(result.status, 'found'); assert.equal(result.product.store_id, 1);
      fails(auth(superAdmin) + rpc, /Operacion no autorizada/);
      fails(auth(other) + rpc, /Operacion no autorizada/);
    });
    await t.test('helpers are SECURITY DEFINER with empty search_path and minimal ACLs', () => {
      assert.equal(query("select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='kafka_modules' and p.prosecdef and p.proconfig @> array['search_path=\"\"']"), '3');
      assert.equal(query("select has_function_privilege('anon','kafka_modules.module_enabled(bigint,text)','EXECUTE'), has_function_privilege('anon','kafka_modules.can_manage(bigint,text)','EXECUTE'), has_function_privilege('authenticated','kafka_modules.global_role()','EXECUTE'), has_schema_privilege('authenticated','kafka_modules','CREATE')"), 't|f|t|f');
      assert.equal(query("select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace cross join lateral aclexplode(p.proacl) a where n.nspname='kafka_modules' and a.grantee in (0,'service_role'::regrole)"), '0');
    });
    await t.test('unexpected permissive policy aborts safely instead of silently widening access', () => {
      query('create policy unexpected_allow on public.services for all to authenticated using(true) with check(true);');
      const snapshot = rows();
      const r = spawnSync(exe('psql'), args, { input: migration, env, encoding: 'utf8', timeout: 10000 });
      assert.notEqual(r.status, 0); assert.match(r.stderr, /politicas no previstas/);
      assert.equal(rows(), snapshot);
      assert.equal(query("select count(*) from pg_policies where policyname='unexpected_allow'"), '1');
      query('drop policy unexpected_allow on public.services;');
      fails(`create policy kafka_4b_features_read on public.services for select to anon using(true); ${migration}`, /politicas no previstas/);
      fails(`create policy unexpected_store_insert on public.stores for insert to authenticated with check(true); ${migration}`, /politicas no previstas/);
      fails(`create policy unexpected_store_update on public.stores for update to authenticated using(true) with check(true); ${migration}`, /politicas no previstas/);
    });
    await t.test('unsafe Auth grants, disabled store RLS and unexpected column grants stop application', () => {
      fails(`grant update(raw_app_meta_data) on auth.users to authenticated; ${migration}`, /permisos Auth inseguros/);
      fails(`alter table public.stores disable row level security; ${migration}`, /stores debe conservar RLS/);
      fails(`grant select(title) on public.services to anon; ${migration}`, /grants por columna no previstos/);
      assert.equal(protectedCatalog(), before);
    });
    await t.test('schema/type and validated foreign key prerequisites are checked before changes', () => {
      fails(`alter table public.services alter column sort_order type bigint; ${migration}`, /esquema incompatible/);
      const fk = query("select conname from pg_constraint where conrelid='public.staff'::regclass and contype='f'");
      fails(`alter table public.staff drop constraint ${fk}; ${migration}`, /revisar PK\/FK/);
      assert.equal(protectedCatalog(), before);
    });
    await t.test('manual reapplication preserves data and contracts without duplicating policies', () => {
      const snapshot = rows();
      query(migration);
      assert.equal(rows(), snapshot); assert.equal(protectedCatalog(), before);
      assert.equal(query("select count(*) from pg_policies where policyname like 'kafka_4b_%'"), '9');
    });
  } finally {
    if (started) run('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']);
    rmSync(root, { recursive: true, force: true });
  }
});
