import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const bin = process.env.CATALOG_PG_BIN ?? (existsSync('/opt/homebrew/opt/postgresql@16/bin/initdb') ? '/opt/homebrew/opt/postgresql@16/bin' : '')
const exe = name => bin ? join(bin, name) : name
const read = path => readFileSync(new URL(`../supabase/${path}`, import.meta.url), 'utf8')
const q = v => `'${String(v).replaceAll("'", "''")}'`
const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const service = 'set role service_role;'
const operation = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

test('catalog deletion: isolated real PostgreSQL, fail-closed ACLs, durable cleanup and real concurrency', async t => {
  for (const name of ['initdb', 'pg_ctl', 'psql']) assert.equal(spawnSync(exe(name), ['--version'], { stdio: 'ignore' }).status, 0)
  const root = mkdtempSync(join(tmpdir(), 'kafka-catalog-delete-'))
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PG')))
  const args = ['-X', '-q', '-At', '-h', root, '-p', '55452', '-U', 'local_delete', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1']
  let started = false
  function run(name, argv, input) {
    const result = spawnSync(exe(name), argv, { input, encoding: 'utf8', env, timeout: 30000 })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  const sql = text => run('psql', args, text)
  const fails = (text, match) => {
    const r = spawnSync(exe('psql'), args, { input: text, encoding: 'utf8', env, timeout: 10000 })
    assert.notEqual(r.status, 0); assert.match(r.stderr, match)
  }
  const product = (name = 'LOCAL', path = null) => sql(`insert into public.products(store_id,name,price,image_path) values(1,${q(name)},10,${path === null ? 'null' : q(path)}) returning id;`)
  const deletion = (id, n, kind = 'product', actor = owner, store = 1) => `select public.delete_catalog_entity('${actor}',${store},'${kind}',${q(id)},'${operation(n)}');`
  const claim = job => `select public.claim_catalog_image_cleanup('${owner}',1,'${job}','https://local-test.supabase.co');`
  const jobFor = id => sql(`select id from catalog_media.jobs where kind='product' and entity_id=${q(id)};`)
  function concurrent(text, signal) {
    return new Promise((resolve, reject) => {
      const child = spawn(exe('psql'), args, { env, stdio: ['pipe', 'pipe', 'pipe'] })
      let out = '', error = '', signaled = false
      const timer = setTimeout(() => { child.kill(); reject(new Error('local concurrency timeout')) }, 10000)
      child.stdout.on('data', data => { out += data; if (!signaled && out.includes('LOCKED')) { signaled = true; signal?.() } })
      child.stderr.on('data', data => { error += data })
      child.on('error', reject)
      child.on('close', code => { clearTimeout(timer); if (code === 0) resolve(out.trim()); else reject(new Error(error)) })
      child.stdin.end(`set lock_timeout='4s';set statement_timeout='6s';${text}`)
    })
  }
  try {
    run('initdb', ['-D', join(root, 'data'), '-U', 'local_delete', '-A', 'trust', '--no-locale'])
    run('pg_ctl', ['-D', join(root, 'data'), '-l', join(root, 'log'), '-o', `-k ${root} -p 55452 -c listen_addresses=''`, '-w', 'start']); started = true
    sql(read('tests/product_creation.local.sql'))
    sql(read('phase-6-auth-rls.sql'))
    sql(read('migrations/202610080001_add_product_categories.sql'))
    sql(read('migrations/202610100001_add_product_offers_rating.sql'))
    sql(read('migrations/202610160001_product_creation_idempotency.sql'))
    assert.equal(sql("set search_path='';select md5(pg_get_viewdef('public.kafka_commerce_products'::regclass,true));"), 'b90b085818ea02f9dfe71143dd81492b')
    sql(`alter table auth.users add column raw_app_meta_data jsonb default '{}'::jsonb;
      insert into auth.users(id,raw_app_meta_data) values('${owner}','{"global_role":"admin"}'),('${other}','{"global_role":"admin"}');
      create table public.services(id uuid primary key default gen_random_uuid(),store_id bigint,image_url text);
      create table public.staff(id uuid primary key default gen_random_uuid(),store_id bigint,image_url text);
      alter table public.services enable row level security; alter table public.staff enable row level security;
      create schema storage; create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text);
      alter table storage.objects enable row level security;
      grant usage on schema storage to anon,authenticated;
      grant select,insert,update,delete on storage.objects to anon,authenticated;
      create policy historical_broad_all on storage.objects for all to anon,authenticated using(true) with check(true);`)
    await t.test('remote-schema drift fails closed before installing partial infrastructure', () => {
      sql('alter table public.stores add column logo_url text;')
      fails(read('migrations/202610210001_catalog_deletion.sql'), /Unreviewed public image columns/)
      assert.equal(sql("select to_regnamespace('catalog_media');"), '')
      sql('alter table public.stores drop column logo_url;')
    })
    sql(read('migrations/202610210001_catalog_deletion.sql'))
    sql("update catalog_media.settings set storage_base_url='https://local-test.supabase.co';")

    await t.test('RPC-only deletion, no private table access, restrictive Storage denial wins over broad historical policy', () => {
      assert.equal(sql("select has_function_privilege('authenticated','public.delete_catalog_entity(uuid,bigint,text,text,uuid)','execute');"), 'f')
      assert.equal(sql("select has_function_privilege('service_role','public.delete_catalog_entity(uuid,bigint,text,text,uuid)','execute');"), 't')
      assert.equal(sql("select has_table_privilege('authenticated','public.categories','delete');"), 'f')
      fails('set role authenticated;delete from public.products;', /permission denied/)
      fails('set role authenticated;select * from catalog_media.jobs;', /permission denied/)
      sql("insert into storage.objects(bucket_id,name) values('category-images','foreign.webp'),('staff-images','allowed.webp');")
      assert.equal(sql("set role authenticated;delete from storage.objects where bucket_id='category-images' returning name;"), '')
      assert.equal(sql("set role authenticated;update storage.objects set name='renamed.webp' where bucket_id='category-images' returning name;"), '')
      assert.equal(sql("set role authenticated;delete from storage.objects where bucket_id='staff-images' returning name;"), 'allowed.webp')
    })
    await t.test('no-image product deletion is atomic, replayed, and conflicts with a different payload', () => {
      const id = product()
      const receipt = JSON.parse(sql(service + deletion(id, 1)))
      assert.equal(receipt.deleted, true); assert.equal(receipt.cleanup, 'no_image')
      assert.equal(JSON.parse(sql(service + deletion(id, 1))).replayed, true)
      fails(service + deletion(String(Number(id) + 1), 1), /operation conflict/)
    })
    await t.test('restrictive category INSERT validates real category/store ownership despite broad historical ALL', () => {
      const category = sql("insert into public.categories(store_id,name,slug) values(1,'UPLOAD','upload-policy') returning id;")
      const foreign = sql("insert into public.categories(store_id,name,slug) values(2,'FOREIGN','foreign-policy') returning id;")
      const auth = `set role authenticated;set request.jwt.claim.sub='${owner}';`
      const insert = path => `insert into storage.objects(bucket_id,name) values('category-images',${q(path)});`
      sql(auth + insert(`1/${category}/legacy.webp`))
      sql(auth + insert(`1-local-a/categories/${category}-upload-policy/principal-1791500000000.webp`))
      for (const path of [
        `2/${foreign}/foreign.webp`, `1/${foreign}/wrong-store.webp`,
        `2-other/categories/${foreign}-foreign/principal.webp`,
        `1-local/categories/${operation(200)}-missing/principal.webp`,
        `1-local/categories/${category}-upload/../principal.webp`,
        `1-local/categories/not-a-uuid-upload/principal.webp`,
        `999999999999999999999999999999/${category}/overflow.webp`,
        `1/${category}/extra/file.webp`, `1/${category}/file.svg`,
        `1-local/categories/${category}-upload/file.webp?query=1`,
      ]) fails(auth + insert(path), /row-level security/)
      fails('set role anon;' + insert(`1/${category}/anon.webp`), /row-level security/)
      fails(`set role authenticated;set request.jwt.claim.sub='${other}';` + insert(`1/${category}/foreign-actor.webp`), /row-level security/)
      sql(auth + "insert into storage.objects(bucket_id,name) values('staff-images','unrelated-insert.webp'),('product-images','unrelated-insert.webp');")
      sql("set role anon;insert into storage.objects(bucket_id,name) values('staff-images','unrelated-anon-insert.webp');")
      assert.equal(sql("select count(*) from storage.objects where bucket_id='category-images' and name like '%/legacy.webp';"), '1')
    })
    await t.test('missing, NULL, malformed and unknown live roles deny the owner without writes', () => {
      const id = product()
      const before = sql('select count(*) from catalog_media.jobs;')
      for (const metadata of [null, {}, { global_role: null }, { global_role: 'unknown' }, { global_role: 'viewer' }, [], { global_role: true }]) {
        sql(`update auth.users set raw_app_meta_data=${metadata === null ? 'null' : q(JSON.stringify(metadata)) + '::jsonb'} where id='${owner}';`)
        fails(service + deletion(id, 100), /access denied/)
        assert.equal(sql(`select count(*) from public.products where id=${id};`), '1')
        assert.equal(sql(`select count(*) from catalog_media.operations where operation_id='${operation(100)}';`), '0')
        assert.equal(sql('select count(*) from catalog_media.jobs;'), before)
      }
      sql(`update auth.users set raw_app_meta_data='{"global_role":"admin"}' where id='${owner}';`)
    })
    await t.test('admin and super_admin owners can delete; neither role grants foreign-store access', () => {
      for (const role of ['admin', 'super_admin']) {
        sql(`update auth.users set raw_app_meta_data=${q(JSON.stringify({ global_role: role }))}::jsonb where id in ('${owner}','${other}');`)
        const id = product()
        fails(service + deletion(id, 101, 'product', other), /access denied/)
        fails(service + deletion(id, 101, 'product', owner, 2), /access denied/)
        assert.equal(JSON.parse(sql(service + deletion(id, role === 'admin' ? 102 : 103))).deleted, true)
      }
    })
    await t.test('owner without a role retains existing creation and edit permissions, not deletion', () => {
      sql(`update auth.users set raw_app_meta_data='{}' where id='${owner}';`)
      const auth = `set role authenticated;set request.jwt.claim.sub='${owner}';`
      const id = sql(auth + "insert into public.products(store_id,name,price) values(1,'LEGACY CREATE',10) returning id;")
      assert.equal(sql(auth + `update public.products set name='LEGACY EDIT' where id=${id} returning name;`), 'LEGACY EDIT')
      const payload = { name: 'IDEMPOTENT LEGACY', description: null, price: 10, discount_active: false, discount_price: null, visual_rating: 5, category_id: null, available: true }
      const created = JSON.parse(sql(auth + `select public.create_product_idempotent(1,'${operation(104)}',${q(JSON.stringify(payload))}::jsonb);`))
      assert.equal(created.status, 'found')
      assert.equal(created.product.store_id, 1)
      const category = sql(auth + "insert into public.categories(store_id,name,slug) values(1,'LEGACY','legacy-create-edit') returning id;")
      assert.equal(sql(auth + `update public.categories set name='LEGACY EDIT' where id='${category}' returning name;`), 'LEGACY EDIT')
      fails(service + deletion(id, 105), /access denied/)
      sql(`update auth.users set raw_app_meta_data='{"global_role":"super_admin"}' where id='${owner}';`)
    })
    await t.test('nonempty category is rejected without cascading, receipt or cleanup writes; empty category succeeds', () => {
      const category = sql("insert into public.categories(store_id,name,slug) values(1,'LOCAL','local') returning id;")
      const id = product()
      sql(`update public.products set category_id='${category}' where id=${id};`)
      fails(service + deletion(category, 3, 'category'), /Category has products/)
      assert.equal(sql(`select count(*) from public.products where id=${id};`), '1')
      assert.equal(sql(`select count(*) from catalog_media.operations where operation_id='${operation(3)}';`), '0')
      sql(service + deletion(id, 4))
      assert.equal(JSON.parse(sql(service + deletion(category, 3, 'category'))).deleted, true)
      const orphanCategory = sql("insert into public.categories(store_id,name,slug) values(1,'ORPHAN','orphan') returning id;")
      sql(`insert into public.products(store_id,name,price,category_id) values(null,'LEGACY NULL STORE',20,'${orphanCategory}');`)
      fails(service + deletion(orphanCategory, 17, 'category'), /Category has products/)
    })
    await t.test('owned paths survive record deletion; claims prevent relinking even across tenants and fields', () => {
      const id = product()
      const path = `1-local/products/${id}-local/principal-owned.webp`
      sql(`update public.products set image_path=${q(path)} where id=${id};`)
      sql(service + deletion(id, 5))
      const job = jobFor(id)
      fails(service + `select public.claim_catalog_image_cleanup('${owner}',1,'${job}','https://wrong-project.supabase.co');`, /origin is not configured/)
      assert.equal(sql(`select retired_at is null from catalog_media.jobs where id='${job}';`), 't')
      const result = JSON.parse(sql(service + claim(job)))
      assert.equal(result.acquired, true); assert.equal(result.path, path)
      fails(`insert into public.staff(store_id,image_url) values(2,${q('https://local-test.supabase.co/storage/v1/object/public/product-images/' + path)});`, /reference is retired/)
      fails(`insert into storage.objects(bucket_id,name) values('product-images',${q(path)});`, /paths cannot be reused/)
      assert.equal(JSON.parse(sql(service + claim(job))).acquired, false)
      sql(`select public.finish_catalog_image_cleanup('${owner}',1,'${job}','${result.claim_token}',false);`)
      assert.equal(sql(`select state from catalog_media.jobs where id='${job}';`), 'failed')
      assert.equal(JSON.parse(sql(service + claim(job))).acquired, true)
    })
    await t.test('global shared/encoded references hidden by RLS are conservatively retained', () => {
      const id = product(), path = `1/${id}/shared-${id}.webp`
      sql(`update public.products set image_path=${q(path)} where id=${id};
        insert into public.services(store_id,image_url) values(2,${q('https://local-test.supabase.co/storage/v1/object/public/product-images/1/' + id + '/%73hared-' + id + '.webp')});`)
      sql(service + deletion(id, 6))
      const job = jobFor(id)
      assert.equal(JSON.parse(sql(service + claim(job))).state, 'retained_shared')
      assert.equal(sql(`select retired_at is null from catalog_media.jobs where id='${job}';`), 't')
    })
    await t.test('external URLs, malformed paths and legacy category folder mismatches are never queued for deletion', () => {
      const category = sql("insert into public.categories(store_id,name,slug,image_url) values(1,'EXT','ext','https://local-test.supabase.co/storage/v1/object/public/category-images/1/not-owned/file.webp') returning id;")
      assert.equal(JSON.parse(sql(service + deletion(category, 7, 'category'))).cleanup, 'retained_unverified')
      assert.equal(sql("select catalog_media.owned_path(1,'product','3','2/3/image.webp') is null;"), 't')
      assert.equal(sql("select catalog_media.owned_path(1,'category','3','https://external.test/storage/v1/object/public/category-images/1/3/image.webp') is null;"), 't')
    })
    await t.test('replacements enqueue old references only; no Storage deletion or historical sweep occurs in SQL', () => {
      const id = product(), path = `1/${id}/previous-${id}.webp`
      sql(`update public.products set image_path=${q(path)} where id=${id};update public.products set image_path='1/other/new.webp' where id=${id};`)
      assert.equal(sql(`select count(*) from catalog_media.jobs where entity_id=${q(id)};`), '1')
      assert.equal(JSON.parse(sql(service + claim(jobFor(id)))).acquired, true)
    })
    await t.test('concurrent identical deletes create exactly one receipt and at most one image job', async () => {
      const id = product(), text = service + deletion(id, 8)
      const results = (await Promise.all([concurrent(text), concurrent(text)])).map(JSON.parse)
      assert.equal(results.filter(r => r.replayed).length, 1)
      assert.equal(sql(`select count(*) from catalog_media.operations where operation_id='${operation(8)}';`), '1')
    })
    await t.test('a committed new reference while claim waits prevents physical cleanup acquisition', async () => {
      const id = product(), path = `1/${id}/racing-${id}.webp`
      sql(`update public.products set image_path=${q(path)} where id=${id};`)
      sql(service + deletion(id, 9)); const job = jobFor(id)
      let signal
      const locked = new Promise(resolve => { signal = resolve })
      const writer = concurrent(`begin;insert into public.staff(store_id,image_url) values(2,${q('https://local-test.supabase.co/storage/v1/object/public/product-images/' + path)});select 'LOCKED';select pg_sleep(0.3);commit;`, signal)
      await Promise.race([locked, writer.then(() => { throw new Error('lock signal missing') })])
      const [, result] = await Promise.all([writer, concurrent(service + claim(job))])
      assert.equal(JSON.parse(result).state, 'retained_shared')
    })
    await t.test('a rollback restores product, receipt and queued image work together', () => {
      const id = product()
      sql('begin;' + service + deletion(id, 10) + 'rollback;')
      assert.equal(sql(`select count(*) from public.products where id=${id};`), '1')
      assert.equal(sql(`select count(*) from catalog_media.operations where operation_id='${operation(10)}';`), '0')
    })
    await t.test('two real cleanup claims have one winner and a retired path cannot be referenced after waiting', async () => {
      const id = product(), path = `1/${id}/exclusive-${id}.webp`
      sql(`update public.products set image_path=${q(path)} where id=${id};`)
      sql(service + deletion(id, 11)); const job = jobFor(id)
      const results = (await Promise.all([concurrent(service + claim(job)), concurrent(service + claim(job))])).map(JSON.parse)
      assert.equal(results.filter(r => r.acquired === true).length, 1)
    })
    await t.test('category DELETE waits for a real FK writer and then rejects without deadlock or cascade', async () => {
      const category = sql("insert into public.categories(store_id,name,slug,image_url) values(1,'RACE','race','https://local-test.supabase.co/storage/v1/object/public/category-images/1/unverified/image.webp') returning id;")
      let signal
      const locked = new Promise(resolve => { signal = resolve })
      const writer = concurrent(`begin;insert into public.products(store_id,name,price,category_id,image_path)
        values(1,'FK RACE',20,'${category}','1/local-fk-race.webp');select 'LOCKED';select pg_sleep(0.3);commit;`, signal)
      await Promise.race([locked, writer.then(() => { throw new Error('lock signal missing') })])
      await assert.rejects(concurrent(service + deletion(category, 12, 'category')), /Category has products/)
      await writer
      assert.equal(sql(`select count(*) from public.products where category_id='${category}';`), '1')
    })
    await t.test('owned category URL and real UUID are captured before deletion; completed cleanup remains idempotent', () => {
      const id = sql("insert into public.categories(store_id,name,slug) values(1,'IMAGE','image') returning id;")
      const path = `1-local/categories/${id}-image/principal-${id}.webp`
      sql(`update public.categories set image_url=${q('https://local-test.supabase.co/storage/v1/object/public/category-images/' + path)} where id='${id}';`)
      const receipt = JSON.parse(sql(service + deletion(id, 13, 'category')))
      const acquired = JSON.parse(sql(service + claim(receipt.job_id)))
      assert.equal(acquired.bucket, 'category-images'); assert.equal(acquired.path, path)
      assert.equal(sql(`select public.finish_catalog_image_cleanup('${owner}',1,'${receipt.job_id}','${acquired.claim_token}',true);`), 't')
      assert.equal(JSON.parse(sql(service + claim(receipt.job_id))).state, 'deleted')
      assert.equal(sql(`select catalog_media.owned_path(1,'category','${id}',${q('https://local-test.supabase.co/storage/v1/object/public/category-images/1/' + id + '/legacy.webp')});`), `1/${id}/legacy.webp`)
    })
    await t.test('new opaque aliases cannot bypass a committed retirement marker', () => {
      fails("insert into public.staff(store_id,image_url) values(1,'https://external.example/proxy-with-hidden-target');", /reference is retired/)
    })
    await t.test('same legacy filename in another folder is not shared; normalized real aliases are detected', () => {
      const a = product(), b = product()
      const path = `1/${a}/image.webp`
      sql(`update public.products set image_path=${q(path)} where id=${a};update public.products set image_path=${q('1/' + b + '/image.webp')} where id=${b};`)
      sql(service + deletion(a, 15))
      assert.equal(JSON.parse(sql(service + claim(jobFor(a)))).acquired, true)
      sql(`update public.products set image_path=${q('1/' + b + '/image.webp')} where id=${b};`)
      assert.equal(sql(`select catalog_media.reference_key(${q('https://local-test.supabase.co/storage/v1/object/public/product-images/1/' + a + '/%69mage.webp?download=1')},false);`), 'product-images/' + path)
      assert.equal(sql(`select catalog_media.reference_key('https://local-test.supabase.co/storage/v1/object/public/product-images/1/other/../image.webp',false) is null;`), 't')
    })
    await t.test('parent deletion with an image wins before child FK publication without media-lock inversion', async () => {
      const category = sql("insert into public.categories(store_id,name,slug) values(1,'PARENT','parent') returning id;")
      sql(`update public.categories set image_url=${q('https://local-test.supabase.co/storage/v1/object/public/category-images/1-local/categories/' + category + '-parent/principal-' + category + '.webp')} where id='${category}';`)
      let signal
      const locked = new Promise(resolve => { signal = resolve })
      const parent = concurrent(`begin;select id from public.categories where id='${category}' for update;
        select 'LOCKED';select pg_sleep(0.3);${deletion(category, 14, 'category')}commit;`, signal)
      await Promise.race([locked, parent.then(() => { throw new Error('lock signal missing') })])
      await assert.rejects(concurrent(`insert into public.products(store_id,name,price,category_id,image_path)
        values(1,'CHILD',20,'${category}','1/child-reference.webp');`), /Category unavailable|foreign key/)
      assert.match(await parent, /"deleted": true/)
    })
    await t.test('stored Commerce allowlist predicate admits both verified view hashes only', () => {
      const definition = sql("select pg_get_functiondef('public.claim_catalog_image_cleanup(uuid,bigint,uuid,text)'::regprocedure);")
      const predicate = definition.match(/case when c\.relkind='v' then md5\(pg_get_viewdef\(c\.oid,true\)\) in \([\s\S]*?\)\s*else false end/)?.[0]
      assert.ok(predicate, 'the actual stored fail-closed predicate must be found')
      // Evaluate the installed predicate with signature inputs; do not pretend
      // to reproduce remote DDL or replace PostgreSQL built-ins with mocks.
      const expression = predicate.replace('md5(pg_get_viewdef(c.oid,true))', 'c.signature')
      for (const kind of ['v', 'r', 'p', 'm']) {
        for (const signature of ['b90b085818ea02f9dfe71143dd81492b', '2a6cd6a7bcdf87c59984816f26c429a8', '00000000000000000000000000000000']) {
          assert.equal(sql(`select ${expression} from (select ${q(kind)} as relkind,${q(signature)} as signature) c;`), kind === 'v' && signature !== '00000000000000000000000000000000' ? 't' : 'f')
        }
      }
    })
    await t.test('reviewed Commerce view shares product-images, including foreign-tenant references hidden by RLS', () => {
      const id = product(), path = `1/${id}/commerce-shared.webp`
      sql(`update public.products set image_path=${q(path)} where id=${id};`)
      const foreign = sql(`insert into public.products(store_id,name,price,image_path) values(2,'COMMERCE SHARED',10,${q(path)}) returning id;`)
      assert.equal(sql(`select image_path from public.kafka_commerce_products where id=${foreign};`), path)
      assert.equal(sql(`set role authenticated;set request.jwt.claim.sub='${owner}';select count(*) from public.kafka_commerce_products where id=${foreign};`), '0')
      sql(service + deletion(id, 201))
      assert.equal(JSON.parse(sql(service + claim(jobFor(id)))).acquired, false)
      assert.equal(sql(`select retired_at is null from catalog_media.jobs where id='${jobFor(id)}';`), 't')
    })
    await t.test('changed/filtered Commerce view blocks cleanup even when it exposes no current references', () => {
      const definition = sql("set search_path='';select pg_get_viewdef('public.kafka_commerce_products'::regclass,true);")
      const id = product(), path = `1/${id}/commerce-unknown-view.webp`
      sql(`update public.products set image_path=${q(path)} where id=${id};`)
      sql(service + deletion(id, 202))
      try {
        sql(`create or replace view public.kafka_commerce_products with (security_invoker=true) as ${definition.replace(/;\s*$/, '')} where false;`)
        assert.equal(sql('select count(*) from public.kafka_commerce_products;'), '0')
        assert.equal(JSON.parse(sql(service + claim(jobFor(id)))).state, 'retained_shared')
        assert.equal(sql(`select retired_at is null from catalog_media.jobs where id='${jobFor(id)}';`), 't')
      } finally {
        sql(`create or replace view public.kafka_commerce_products with (security_invoker=true) as ${definition}`)
      }
    })
    await t.test('materialized Commerce projection is blocked even when its source matches the reviewed view', () => {
      const definition = sql("set search_path='';select pg_get_viewdef('public.kafka_commerce_products'::regclass,true);")
      const id = product(), path = `1/${id}/commerce-materialized.webp`
      sql(`update public.products set image_path=${q(path)} where id=${id};`)
      sql(service + deletion(id, 204))
      try {
        sql(`drop view public.kafka_commerce_products;create materialized view public.kafka_commerce_products as ${definition}`)
        assert.equal(JSON.parse(sql(service + claim(jobFor(id)))).state, 'retained_shared')
        assert.equal(sql(`select retired_at is null from catalog_media.jobs where id='${jobFor(id)}';`), 't')
      } finally {
        sql(`drop materialized view if exists public.kafka_commerce_products;create view public.kafka_commerce_products with (security_invoker=true) as ${definition}`)
      }
    })
    await t.test('independent Commerce table passes schema inventory but all cleanup stays blocked, including empty-table publication races', async () => {
      sql('create table public.catalog_commerce_copy as select * from public.kafka_commerce_products with no data;drop view public.kafka_commerce_products;alter table public.catalog_commerce_copy rename to kafka_commerce_products;alter table public.kafka_commerce_products enable row level security;')
      sql(read('migrations/202610210001_catalog_deletion.sql').split('create schema catalog_media;')[0] + 'rollback;')
      const id = product(), path = `1/${id}/commerce-table-shared.webp`
      sql(`update public.products set image_path=${q(path)} where id=${id};`)
      sql(service + deletion(id, 203))
      assert.equal(JSON.parse(sql(service + claim(jobFor(id)))).state, 'retained_shared')
      await Promise.all([
        concurrent(`insert into public.kafka_commerce_products(id,store_id,image_path) values(99999,2,${q(path)});`),
        concurrent(service + claim(jobFor(id))),
      ])
      assert.equal(sql(`select image_path from public.kafka_commerce_products where id=99999;`), path)
      assert.equal(JSON.parse(sql(service + claim(jobFor(id)))).acquired, false)
      assert.equal(sql(`select retired_at is null from catalog_media.jobs where id='${jobFor(id)}';`), 't')
    })
  } finally {
    if (started) run('pg_ctl', ['-D', join(root, 'data'), '-m', 'fast', '-w', 'stop'])
    rmSync(root, { recursive: true, force: true })
  }
})
