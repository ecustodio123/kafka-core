import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const bin = process.env.CATALOG_PG_BIN ?? (existsSync('/opt/homebrew/opt/postgresql@16/bin/initdb') ? '/opt/homebrew/opt/postgresql@16/bin' : '')
const exe = name => bin ? join(bin, name) : name
const read = file => readFileSync(new URL(`../supabase/${file}`, import.meta.url), 'utf8')
const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', superAdmin = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const auth = (user = owner) => `set role authenticated; set request.jwt.claim.sub='${user}';`
const id = '10000000-0000-4000-8000-000000000001'
const path = `1-local-a/publications/${id}-local-draft/documento-30000000-0000-4000-8000-000000000001.pdf`

test('Publications: real isolated PostgreSQL RLS, paths, permissions and concurrency; no remote or skipped tests', async t => {
  const root = mkdtempSync(join(tmpdir(), 'kafka-publications-'))
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('PG')))
  const args = ['-X','-q','-At','-h',root,'-p','55467','-U','publications_test','-d','postgres','-v','ON_ERROR_STOP=1']
  let started = false
  function run(command, argv, sql) {
    const r = spawnSync(exe(command), argv, { env, input: sql, encoding: 'utf8', timeout: 30000 })
    assert.equal(r.status, 0, r.stderr || `${command} failed; no skips`)
    return r.stdout.trim()
  }
  const query = sql => run('psql', args, sql)
  const check = sql => query(`begin; ${sql}; rollback;`)
  function fails(sql, pattern = /permission denied|row-level security/) {
    const r = spawnSync(exe('psql'), args, { env, input: `begin; ${sql}`, encoding: 'utf8', timeout: 10000 })
    assert.notEqual(r.status, 0); assert.match(r.stderr, pattern)
  }
  function concurrent(sql) {
    return new Promise(resolve => {
      const p = spawn(exe('psql'), args, { env }); let stderr = '', stdout = ''
      p.stdout.on('data', d => { stdout += d }); p.stderr.on('data', d => { stderr += d })
      p.on('close', status => resolve({ status, stdout, stderr })); p.stdin.end(sql)
    })
  }
  try {
    run('initdb',['-D',join(root,'data'),'-U','publications_test','-A','trust','--no-locale'])
    run('pg_ctl',['-D',join(root,'data'),'-l',join(root,'server.log'),'-o',`-k ${root} -p 55467 -c listen_addresses=''`,'-w','start']); started = true
    for (const file of ['tests/product_creation.local.sql','phase-6-auth-rls.sql','migrations/202610080001_add_product_categories.sql',
      'migrations/202610100001_add_product_offers_rating.sql','migrations/202610160001_product_creation_idempotency.sql',
      'tests/store_modules.local.sql','migrations/202610200001_store_modules_security.sql','tests/publications.local.sql']) query(read(file))
    const sql = read('migrations/202610260001_publications_v1.sql')
    const snapshot = () => query(`select jsonb_build_object('rows',(select jsonb_agg(to_jsonb(p)||jsonb_build_object(
        'publication_type',case when publication_type='pdf' then 'document' else publication_type end) order by id) from public.publications p),
      'policies',(select jsonb_agg(to_jsonb(p) order by tablename,policyname) from pg_policies p where schemaname='public' and tablename in ('products','categories','services','staff')),
      'other_grants',(select jsonb_agg(jsonb_build_array(c.relname,c.relacl) order by c.relname) from pg_class c
        where c.oid in ('public.products'::regclass,'public.categories'::regclass,'public.services'::regclass,'public.staff'::regclass)),
      'stores',(select jsonb_agg(to_jsonb(s) order by id) from public.stores s),
      'services',(select jsonb_agg(to_jsonb(s) order by id) from public.services s),
      'staff',(select jsonb_agg(to_jsonb(s) order by id) from public.staff s),
      'users',(select jsonb_agg(to_jsonb(u) order by id) from auth.users u),
      'roles',(select jsonb_agg(jsonb_build_array(rolname,rolsuper,rolbypassrls) order by rolname) from pg_roles),
      'global_role',pg_get_functiondef('kafka_modules.global_role()'::regprocedure),
      'legacy_function',pg_get_functiondef('public.set_publications_updated_at()'::regprocedure),
      'view',pg_get_viewdef('public.kafka_commerce_products'::regclass,true));`)
    const before = snapshot()
    const originalRows = JSON.parse(query('select jsonb_agg(to_jsonb(p) order by id) from public.publications p'))
    await t.test('single-result preflight actually reports legacy type/default/trigger, RLS, grants and bucket without writes', () => {
      const p = JSON.parse(query(read('publications-v1-preflight.sql')))
      assert.equal(p.columns.find(c=>c.table==='publications'&&c.column==='publication_type').default,"'pdf'::text")
      assert.ok(p.constraints.some(c=>c.definition.includes("'pdf'::text")))
      assert.equal(p.triggers[0].name,'trg_publications_updated_at')
      assert.match(p.triggers[0].function,/NEW.updated_at = NOW\(\)/)
      assert.equal(p.bucket.public,false)
      assert.ok(p.policies.some(policy=>policy.policyname==='historical_publications_allow'))
      assert.ok(p.column_acls.some(column=>column.acl!==null))
      assert.equal(snapshot(),before)
    })
    await t.test('preflight rejects unknown type rules/defaults and altered legacy trigger before changing data', () => {
      fails(`create or replace function public.set_publications_updated_at() returns trigger language plpgsql set search_path='' as $$ begin new.title='changed'; new.updated_at=now(); return new; end; $$; ${sql}`,/trigger updated_at no coincide/)
      fails(`alter table public.publications add constraint unreviewed_type check(publication_type<>'pdf' or title<>'Blocked'); ${sql}`,/CHECK de tipo no reconocido/)
      fails(`alter table public.publications alter column publication_type set default upper('pdf'); ${sql}`,/default de publication_type no reconocido/)
      fails(`create policy legacy_type_filter on public.publications for select to anon using(publication_type='pdf'); ${sql}`,/politica dependiente/)
      fails(`create view public.local_type_view as select * from public.publications where publication_type='pdf'; ${sql}`,/vista dependiente/)
      fails(`alter table public.publications add unique(publication_type); create table public.local_type_reference(kind text references public.publications(publication_type) on update cascade); ${sql}`,/FK dependiente/)
      assert.equal(snapshot(),before)
      assert.equal(query("select count(*) from public.publications where publication_type='pdf'"),'1')
    })
    await t.test('failure after conversion rolls back type, default, trigger, grants, policies and every field', () => {
      // This reaches type conversion, then fails the later field validation.
      fails(`update public.publications set title='' where publication_type='pdf'; ${sql}`,/kafka_publications_fields/)
      assert.equal(snapshot(),before)
      assert.deepEqual(JSON.parse(query('select jsonb_agg(to_jsonb(p) order by id) from public.publications p')),originalRows)
      assert.equal(query("select count(*) from pg_trigger where tgrelid='public.publications'::regclass and tgname='trg_publications_updated_at'"),'1')
      assert.equal(query("select pg_get_expr(adbin,adrelid) from pg_attrdef where adrelid='public.publications'::regclass and adnum=(select attnum from pg_attribute where attrelid='public.publications'::regclass and attname='publication_type')"),"'pdf'::text")
    })
    query(sql)
    await t.test('migration is valid and idempotent; existing rows/catalog/content policies/view are preserved', () => {
      query(sql); assert.equal(snapshot(), before)
      assert.equal(query('select count(*) from public.store_features where publications_enabled is true'), '0')
    })
    await t.test('pdf to document preserves EVERY other field, article data, historical dates and shared trigger function', () => {
      const actual = JSON.parse(query('select jsonb_agg(to_jsonb(p) order by id) from public.publications p'))
      assert.deepEqual(actual,originalRows.map(row=>({...row,publication_type:row.publication_type==='pdf'?'document':row.publication_type})))
      assert.equal(query("select pg_get_expr(adbin,adrelid) from pg_attrdef where adrelid='public.publications'::regclass and adnum=(select attnum from pg_attribute where attrelid='public.publications'::regclass and attname='publication_type')"),"'document'::text")
      assert.equal(query("select string_agg(tgname,',') from pg_trigger where tgrelid='public.publications'::regclass and not tgisinternal"),'kafka_publications_validate')
      assert.equal(check(`${auth(superAdmin)} update public.publications set title='Updated' where id='${id}' returning updated_at>'2022-01-01Z'::timestamptz`),'t')
      fails(auth(superAdmin)+`update public.publications set publication_type='pdf' where id='${id}'`,/kafka_publications_fields/)
    })
    query('update public.store_features set publications_enabled=true where store_id=1')
    await t.test('only owner/enabled or Super Admin can manage; legacy owner compatibility is preserved', () => {
      assert.equal(check(auth() + 'select count(*) from public.publications'), '1')
      assert.equal(check(auth(other) + 'select count(*) from public.publications'), '0')
      assert.equal(check(auth(superAdmin) + 'select count(*) from public.publications'), '2')
      assert.equal(check(auth() + "select kafka_modules.can_manage(1,'services'),kafka_modules.can_manage(1,'staff')"),'t|f')
      fails(auth(other) + "insert into public.publications(store_id,title,slug,publication_type,status,display_order) values(1,'Bad','bad','document','draft',0)")
      assert.equal(check(auth(other) + `delete from public.publications where id='${id}' returning id`), '')
      assert.equal(check(auth() + "update public.store_features set publications_enabled=false where store_id=1 returning store_id"), '')
      assert.equal(check(auth(superAdmin) + 'update public.store_features set publications_enabled=true where store_id=2 returning store_id'), '2')
    })
    await t.test('first upload requires existing publication, valid path, enabled module and same tenant, despite broad old policies', () => {
      assert.equal(check(auth() + `insert into storage.objects(bucket_id,name) values('publication-files','${path}') returning name`), path)
      fails(auth(other) + `insert into storage.objects(bucket_id,name) values('publication-files','${path}')`)
      fails(auth() + `insert into storage.objects(bucket_id,name) values('publication-files','${path.replace(id,'99999999-0000-4000-8000-000000000001')}')`)
      for (const invalid of [path.replace('1-local-a','2-other'),path.replace('/publications/','/staff/'),path.replace('documento-','../documento-'),
        path.replace('1-local-a','9999999999999999999999999-too-large'),path.replace('.pdf','.exe')]) {
        assert.equal(check(auth(superAdmin) + `select kafka_modules.can_manage_publication_file('${invalid}')`),'f')
      }
    })
    query(`insert into storage.objects(bucket_id,name) values('publication-files','${path}')`)
    await t.test('link then publish document; timestamps are backend generated and retained across edit/archive/republish', () => {
      fails(auth() + `update public.publications set status='published' where id='${id}'`, /kafka_publications_fields/)
      fails(auth() + `update public.publications set pdf_storage_path='${path.replace('30000000','40000000')}',pdf_original_name='doc.pdf',pdf_size_bytes=100 where id='${id}'`, /PDF no disponible/)
      const value = check(`${auth()} update public.publications set pdf_storage_path='${path}',pdf_original_name='doc.pdf',pdf_size_bytes=100,status='published' where id='${id}';
        select published_at::text from public.publications where id='${id}';
        update public.publications set status='archived',title='Edit' where id='${id}';
        update public.publications set status='published' where id='${id}';
        select published_at::text from public.publications where id='${id}'`).split('\n')
      assert.equal(value.length,2); assert.equal(value[0],value[1]); assert.ok(value[0])
    })
    await t.test('public metadata requires published AND enabled; private file paths, author and draft data stay private', () => {
      assert.equal(check('set role anon; select count(id) from public.publications'), '0')
      assert.equal(check(`update public.publications set publication_type='article',status='published' where id='${id}'; set role anon; select title from public.publications`),'LOCAL DRAFT')
      assert.equal(check(`update public.publications set publication_type='article',status='published' where id='${id}'; update public.store_features set publications_enabled=false where store_id=1; set role anon; select count(id) from public.publications`),'0')
      fails('set role anon; select pdf_storage_path from public.publications')
      fails('set role anon; select created_by from public.publications')
      assert.equal(check('set role anon; select count(*) from storage.objects'), '0')
      fails(`set role anon; insert into storage.objects(bucket_id,name) values('publication-files','${path}')`)
    })
    await t.test('no direct overwrite/deletion of PDF objects; other buckets retain their policies', () => {
      assert.equal(check(auth() + `delete from storage.objects where name='${path}' returning id`),'')
      assert.equal(check(auth() + `update storage.objects set name='changed' where name='${path}' returning id`),'')
      fails(auth() + `insert into storage.objects(bucket_id,name) values('publication-files','${path}')`, /duplicate key/)
      assert.equal(check(`insert into storage.buckets(id) values('other-bucket'); ${auth()} insert into storage.objects(bucket_id,name) values('other-bucket','unchanged-access') returning name`),'unchanged-access')
    })
    await t.test('slug uniqueness is per store; client cannot change identity/author/timestamps or use arbitrary file paths', () => {
      fails(auth() + "insert into public.publications(store_id,title,slug,publication_type,status,display_order) values(1,'Duplicate','local-draft','document','draft',0)", /duplicate key/)
      assert.equal(check(auth(superAdmin) + "insert into public.publications(store_id,title,slug,publication_type,status,display_order) values(2,'Same slug','local-draft','document','draft',0) returning slug"),'local-draft')
      for (const column of ['id','store_id','created_by','published_at']) fails(auth() + `update public.publications set ${column}=null where id='${id}'`)
      fails(auth() + `update public.publications set pdf_storage_path='https://external/doc.pdf',pdf_original_name='x.pdf',pdf_size_bytes=1 where id='${id}'`,/Referencia PDF/)
      assert.equal(check(auth() + "insert into public.publications(store_id,title,slug,publication_type,status,display_order) values(1,'Creator','creator','document','draft',0) returning created_by"),owner)
    })
    await t.test('real concurrent INSERTs with same UUID have exactly one winner and one row', async () => {
      const identity = '40000000-0000-4000-8000-000000000004'
      const statement = `begin; ${auth()} insert into public.publications(id,store_id,title,slug,publication_type,status,display_order) values('${identity}',1,'Concurrent','concurrent','document','draft',0); select pg_sleep(0.1); commit;`
      const results = await Promise.all([concurrent(statement),concurrent(statement)])
      assert.equal(results.filter(r=>r.status===0).length,1)
      assert.match(results.find(r=>r.status!==0).stderr,/duplicate key/)
      assert.equal(query(`select count(*) from public.publications where id='${identity}'`),'1')
    })
    await t.test('deleting record leaves PDF intact; ownership transfer and disable revoke subsequent access', () => {
      assert.equal(check(`${auth()} delete from public.publications where id='${id}'; reset role; select count(*) from storage.objects`),'1')
      assert.equal(check(`update public.store_features set publications_enabled=false where store_id=1; ${auth()} select count(*) from public.publications`),'0')
      assert.equal(check(`update public.stores set owner_user_id='${other}' where id=1; ${auth()} select count(*) from public.publications`),'0')
    })
    await t.test('helpers have empty search_path and least privilege; incompatible preflight fails without changes', () => {
      assert.equal(query("select has_function_privilege('anon','kafka_modules.can_manage_publication_file(text)','EXECUTE'),has_function_privilege('authenticated','kafka_modules.can_manage_publication_file(text)','EXECUTE'),has_schema_privilege('authenticated','kafka_modules','CREATE')"),'f|t|f')
      assert.equal(query("select proconfig @> array['search_path=\"\"'] from pg_proc where oid='kafka_modules.validate_publication()'::regprocedure"),'t')
      fails(`update storage.buckets set public=true where id='publication-files'; ${sql}`,/bucket existente/)
      fails(`alter table public.publications alter column display_order type bigint; ${sql}`,/esquema incompatible/)
      fails(`create policy unexpected on public.store_features for all to authenticated using(true) with check(true); ${sql}`,/politicas efectivas/)
    })
  } finally {
    if (started) spawnSync(exe('pg_ctl'),['-D',join(root,'data'),'-m','immediate','-w','stop'],{ env, stdio:'ignore' })
    rmSync(root,{ recursive:true,force:true })
  }
})
