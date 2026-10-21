import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const bin = process.env.CATALOG_PG_BIN ?? (existsSync('/opt/homebrew/opt/postgresql@16/bin/initdb') ? '/opt/homebrew/opt/postgresql@16/bin' : '')
const executable = name => bin ? join(bin, name) : name
const read = file => readFileSync(new URL(`../supabase/${file}`, import.meta.url), 'utf8')
const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const superAdmin = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const auth = id => `set role authenticated; set request.jwt.claim.sub='${id}';`
const servicePath = '1-local-a/services/10000000-0000-4000-8000-000000000001-service/principal-30000000-0000-4000-8000-000000000001.webp'
const staffPath = '1-local-a/staff/20000000-0000-4000-8000-000000000001-staff/principal-30000000-0000-4000-8000-000000000001.webp'

test('4D: real isolated PostgreSQL CRUD, RLS and draft Storage SQL; no remote connections or skips', async t => {
  const root = mkdtempSync(join(tmpdir(), 'kafka-content-'))
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PG')))
  const args = ['-X', '-q', '-At', '-h', root, '-p', '55456', '-U', 'content_test', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1']
  let started = false
  function run(command, argv, sql) {
    const r = spawnSync(executable(command), argv, { env, input: sql, encoding: 'utf8', timeout: 30000 })
    assert.equal(r.status, 0, r.stderr || `${command} failed; no skips`)
    return r.stdout.trim()
  }
  const query = sql => run('psql', args, sql)
  const check = sql => query(`begin; ${sql}; rollback;`)
  const fails = (sql, expected = /permission denied|row-level security/) => {
    const r = spawnSync(executable('psql'), args, { env, input: `begin; ${sql}`, encoding: 'utf8', timeout: 10000 })
    assert.notEqual(r.status, 0); assert.match(r.stderr, expected)
  }
  try {
    run('initdb', ['-D', join(root, 'data'), '-U', 'content_test', '-A', 'trust', '--no-locale'])
    run('pg_ctl', ['-D', join(root, 'data'), '-l', join(root, 'server.log'), '-o', `-k ${root} -p 55456 -c listen_addresses=''`, '-w', 'start'])
    started = true
    for (const file of ['tests/product_creation.local.sql', 'phase-6-auth-rls.sql',
      'migrations/202610080001_add_product_categories.sql', 'migrations/202610100001_add_product_offers_rating.sql',
      'migrations/202610160001_product_creation_idempotency.sql', 'tests/store_modules.local.sql',
      'migrations/202610200001_store_modules_security.sql']) query(read(file))
    query(`create schema storage;
      create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
      create table storage.objects(id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id), name text, unique(bucket_id,name));
      alter table storage.objects enable row level security;
      grant usage on schema storage to anon, authenticated;
      grant select, insert, update, delete on storage.objects to anon, authenticated;
      insert into storage.buckets(id,name,public) values ('product-images','product-images',true),('category-images','category-images',true);
      create policy existing_product_read on storage.objects for select to authenticated using (bucket_id='product-images');`)
    const protectedState = () => query(`select jsonb_build_object(
      'policies',(select jsonb_agg(to_jsonb(p) order by schemaname,tablename,policyname) from pg_policies p where schemaname='public' or policyname='existing_product_read'),
      'features',(select jsonb_agg(to_jsonb(f) order by store_id) from public.store_features f),
      'buckets',(select jsonb_agg(to_jsonb(b) order by id) from storage.buckets b where id in ('product-images','category-images')));`)
    const before = protectedState()
    const sql = read('step-4d-content-storage.sql')
    query(sql)
    await t.test('draft is syntactically valid, idempotent and preserves existing catalog/4B policies and buckets', () => {
      query(sql); assert.equal(protectedState(), before)
      assert.equal(query("select count(*) from storage.buckets where id in ('service-images','staff-images') and public and file_size_limit=2097152 and allowed_mime_types=array['image/webp'];"), '2')
    })
    await t.test('owner service upload is allowed; disabled staff and another tenant are denied', () => {
      assert.equal(check(`${auth(owner)} select kafka_modules.can_manage_module_image('service-images','${servicePath}')`), 't')
      assert.equal(check(`${auth(owner)} select kafka_modules.can_manage_module_image('staff-images','${staffPath}')`), 'f')
      assert.equal(check(`${auth(other)} select kafka_modules.can_manage_module_image('service-images','${servicePath}')`), 'f')
      fails(`${auth(other)} insert into storage.objects(bucket_id,name) values ('service-images','${servicePath}')`)
      fails(`${auth(owner)} insert into storage.objects(bucket_id,name) values ('staff-images','${staffPath}')`)
    })
    await t.test('Super Admin can upload to disabled/foreign modules but never use mismatched identities', () => {
      assert.equal(check(`${auth(superAdmin)} select kafka_modules.can_manage_module_image('staff-images','${staffPath}')`), 't')
      const foreign = servicePath.replace('1-local-a/', '2-local-b/').replace('000000000001-service/', '000000000003-service/')
      assert.equal(check(`${auth(superAdmin)} select kafka_modules.can_manage_module_image('service-images','${foreign}')`), 't')
      assert.equal(check(`${auth(superAdmin)} select kafka_modules.can_manage_module_image('service-images','${servicePath.replace('1-local-a/', '2-local-b/')}')`), 'f')
    })
    await t.test('malformed, overflowing, traversal and cross-module paths fail without conversion errors', () => {
      for (const path of [servicePath.replace('1-local-a', '999999999999999999999999999999-store'), servicePath.replace('services/', 'staff/'),
        servicePath.replace('10000000-0000-4000-8000-000000000001', 'invalid'), servicePath.replace('principal-', '../principal-'), servicePath.replace('.webp', '.png')]) {
        assert.equal(check(`${auth(superAdmin)} select kafka_modules.can_manage_module_image('service-images','${path}')`), 'f')
      }
    })
    query(`${auth(owner)} insert into storage.objects(bucket_id,name) values ('service-images','${servicePath}');`)
    await t.test('unique path cannot overwrite; no UPDATE or DELETE policies; anon cannot list or write', () => {
      fails(`${auth(owner)} insert into storage.objects(bucket_id,name) values ('service-images','${servicePath}')`, /duplicate key/)
      assert.equal(check(`${auth(owner)} update storage.objects set name='changed' returning id`), '')
      assert.equal(check(`${auth(owner)} delete from storage.objects returning id`), '')
      assert.equal(check('set role anon; select count(*) from storage.objects'), '0')
      fails(`set role anon; insert into storage.objects(bucket_id,name) values ('service-images','${servicePath}')`)
    })
    await t.test('draft false is persisted despite DEFAULT TRUE; tenant/identity mutations are denied', () => {
      assert.equal(check(`${auth(owner)} insert into public.services(store_id,title,is_active) values (1,'Draft',false) returning is_active`), 'f')
      assert.equal(check(`${auth(other)} delete from public.services where store_id=1 returning id`), '')
      fails(`${auth(owner)} update public.services set store_id=2 where store_id=1`)
      assert.equal(check(`${auth(owner)} update public.services set title='Changed',is_active=false where id='10000000-0000-4000-8000-000000000001' returning title`), 'Changed')
    })
    await t.test('disabling module revokes subsequent writes; deleting/unlinking records retains original objects', () => {
      fails(`update public.store_features set services_enabled=false where store_id=1; ${auth(owner)} insert into storage.objects(bucket_id,name) values ('service-images','${servicePath.replace('30000000', '40000000')}')`)
      assert.equal(check(`${auth(owner)} delete from public.services where id='10000000-0000-4000-8000-000000000001'; reset role; select count(*) from storage.objects`), '1')
    })
    await t.test('private helper has safe search_path and least privilege; incompatible buckets abort without changing them', () => {
      assert.equal(query("select prosecdef and proconfig=array['search_path=\"\"'] from pg_proc where oid='kafka_modules.can_manage_module_image(text,text)'::regprocedure"), 't')
      assert.equal(query("select has_function_privilege('anon','kafka_modules.can_manage_module_image(text,text)','EXECUTE'),has_function_privilege('authenticated','kafka_modules.can_manage_module_image(text,text)','EXECUTE')"), 'f|t')
      query("update storage.buckets set public=false where id='service-images'")
      fails(sql, /bucket existente incompatible/)
      assert.equal(query("select public from storage.buckets where id='service-images'"), 'f')
    })
  } finally {
    if (started) spawnSync(executable('pg_ctl'), ['-D', join(root, 'data'), '-m', 'immediate', '-w', 'stop'], { env, stdio: 'ignore' })
    rmSync(root, { recursive: true, force: true })
  }
})
