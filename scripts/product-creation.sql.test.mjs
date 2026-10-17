import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createProductCreationCoordinator } from '../src/services/productCreation.ts';
import { parseProductForm } from '../src/features/products/productForm.ts';

const read = (path) => readFileSync(new URL(`../supabase/${path}`, import.meta.url), 'utf8');
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const input = { name: 'LOCAL product', description: '', price: 20, discount_active: false,
  discount_price: null, visual_rating: 5, category_id: null, available: true };
const op = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const pgBin = process.env.CATALOG_PG_BIN ??
  (existsSync('/opt/homebrew/opt/postgresql@16/bin/initdb') ? '/opt/homebrew/opt/postgresql@16/bin' : null);
const executable = (name) => pgBin ? join(pgBin, name) : name;

test('catalog creation: isolated PostgreSQL, no remote connection and no skipped cases', async (t) => {
  for (const tool of ['initdb', 'pg_ctl', 'psql']) {
    assert.equal(spawnSync(executable(tool), ['--version'], { stdio: 'ignore' }).status, 0, `${tool} required; refusing to skip`);
  }
  const root = mkdtempSync(join(tmpdir(), 'kafka-catalog-'));
  const data = join(root, 'data');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PG')));
  const args = ['-X', '-q', '-h', root, '-p', '55449', '-U', 'catalog_test', '-d', 'postgres', '-At', '-v', 'ON_ERROR_STOP=1'];
  let started = false;
  function run(cmd, argv, source) {
    const result = spawnSync(executable(cmd), argv, { input: source, encoding: 'utf8', env, timeout: 30000 });
    assert.equal(result.status, 0, result.stderr || `${cmd} failed`);
    return result.stdout.trim();
  }
  const query = (source) => run('psql', args, source);
  const auth = (user = owner, role = 'authenticated') =>
    `set role ${role}; set request.jwt.claim.sub=${quote(user)};`;
  const call = (n, payload = input, store = 1) => `select public.create_product_idempotent(
    ${store},${quote(op(n))},${payload === null ? 'null' : `${quote(JSON.stringify(payload))}::jsonb`});`;
  const invoke = (n, payload = input, store = 1, user = owner) => JSON.parse(query(auth(user) + call(n, payload, store)));
  const count = () => query('select count(*) from public.products;');
  function fails(source, pattern) {
    const result = spawnSync(executable('psql'), args, { input: source, encoding: 'utf8', env, timeout: 10000 });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, pattern);
  }
  function concurrent(source, onLocked) {
    return new Promise((resolve, reject) => {
      const child = spawn(executable('psql'), args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = ''; let error = ''; let signaled = false;
      const timer = setTimeout(() => { child.kill(); reject(new Error('local SQL timeout')); }, 12000);
      child.stdout.on('data', (part) => {
        output += part;
        if (!signaled && output.includes('CATALOG_LOCKED')) { signaled = true; onLocked?.(); }
      });
      child.stderr.on('data', (part) => { error += part; });
      child.on('error', (err) => { clearTimeout(timer); reject(err); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(output.trim()); else reject(new Error(error));
      });
      child.stdin.end(`set lock_timeout='5s'; set statement_timeout='8s'; ${source}`);
    });
  }
  try {
    run('initdb', ['-D', data, '-U', 'catalog_test', '-A', 'trust', '--no-locale']);
    run('pg_ctl', ['-D', data, '-l', join(root, 'server.log'), '-o', `-k ${root} -p 55449 -c listen_addresses=''`, '-w', 'start']);
    started = true;
    query(read('tests/product_creation.local.sql'));
    query(read('phase-6-auth-rls.sql'));
    query(read('migrations/202610080001_add_product_categories.sql'));
    query(read('migrations/202610100001_add_product_offers_rating.sql'));
    query('alter table public.products add column if not exists image_path text;');
    // Supabase installations may grant defaults to these roles. Explicit REVOKEs
    // must win over inherited object-creation defaults, not only vanilla PG ACLs.
    query(`alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
      alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;`);
    const catalogMetadata = () => query(`select jsonb_build_object(
      'columns', (select jsonb_agg(to_jsonb(c) order by c.table_name,c.ordinal_position)
        from information_schema.columns c where c.table_schema='public'
          and c.table_name in ('products','stores','categories','kafka_commerce_products')),
      'relations', (select jsonb_agg(jsonb_build_array(c.relname,c.relacl,c.relrowsecurity,c.relforcerowsecurity) order by c.relname)
        from pg_class c where c.oid in ('public.products'::regclass,'public.stores'::regclass,
          'public.categories'::regclass,'public.kafka_commerce_products'::regclass)),
      'policies', (select jsonb_agg(to_jsonb(p) order by p.tablename,p.policyname)
        from pg_policies p where p.schemaname='public' and p.tablename in ('products','stores','categories')),
      'view', pg_get_viewdef('public.kafka_commerce_products'::regclass,true));`);
    const metadataBeforeMigration = catalogMetadata();
    query(read('migrations/202610160001_product_creation_idempotency.sql'));

    await t.test('migration preserves existing columns, catalog policies, grants and view definition', () => {
      assert.equal(catalogMetadata(), metadataBeforeMigration);
    });

    await t.test('new create, normalized replay and read-only recovery return the same product', () => {
      const first = invoke(1, { ...input, name: '  LOCAL product  ' });
      assert.equal(first.replayed, false);
      assert.equal(first.product.image_path, null);
      assert.equal(first.product.active, true);
      const before = query('select row_to_json(o) from public.product_creation_operations o;');
      assert.equal(invoke(1).product.id, first.product.id);
      assert.equal(invoke(1, null).product.id, first.product.id);
      assert.equal(query('select row_to_json(o) from public.product_creation_operations o;'), before);
      assert.equal(count(), '1');
      assert.equal(invoke(99, null).status, 'not_found');
    });
    await t.test('different payload cannot mutate or disclose an existing result', () => {
      for (const patch of [{ price: 21 }, { name: 'Other' }, { available: false }]) {
        fails(auth() + call(1, { ...input, ...patch }), /Conflicto de operacion/);
      }
      assert.equal(count(), '1');
    });
    await t.test('edited product is returned without restoring its original values', () => {
      const id = invoke(1).product.id;
      query(`update public.products set name='EDITED', price=25 where id=${id};`);
      assert.equal(invoke(1).product.name, 'EDITED');
      assert.equal(invoke(1).product.price, 25);
    });
    await t.test('deleted product leaves a consumed operation and never recreates', () => {
      const id = invoke(2).product.id;
      query(`delete from public.products where id=${id};`);
      const before = count();
      assert.equal(invoke(2).status, 'deleted');
      assert.equal(invoke(2, null).status, 'deleted');
      assert.equal(count(), before);
      assert.equal(query(`select store_id||':'||(product_id is null)||':'||(product_store_id is null)
        from public.product_creation_operations where operation_id=${quote(op(2))};`), '1:true:true');
    });
    await t.test('tenant isolation and same operation UUID in a different authorized store', () => {
      fails(auth(other) + call(1), /Operacion no autorizada/);
      fails(auth() + call(1, null, 2), /Operacion no autorizada/);
      const result = invoke(1, input, 2, other);
      assert.equal(result.product.store_id, 2);
      assert.notEqual(result.product.id, invoke(1).product.id);
    });
    await t.test('new owner cannot replay the original owner operation', () => {
      query(`update public.stores set owner_user_id=${quote(other)} where id=1;`);
      fails(auth(other) + call(1), /Conflicto de operacion/);
      fails(auth(other) + call(1, null), /Conflicto de operacion/);
      fails(auth() + call(1), /Operacion no autorizada/);
      query(`update public.stores set owner_user_id=${quote(owner)} where id=1;`);
    });
    await t.test('category must belong to the store; failed creation fully rolls back', () => {
      const category = query("insert into public.categories(store_id,name,slug) values(2,'LOCAL','local') returning id;");
      const before = count();
      fails(auth() + call(3, { ...input, category_id: category }), /Categoria no disponible/);
      assert.equal(count(), before);
      assert.equal(query(`select count(*) from public.product_creation_operations where operation_id=${quote(op(3))};`), '0');
      assert.equal(invoke(3).status, 'found');
      const ownCategory = query("insert into public.categories(store_id,name,slug) values(1,'LOCAL','local') returning id;");
      assert.equal(invoke(4, { ...input, category_id: ownCategory }).product.category_id, ownCategory);
    });
    await t.test('allowlist, strict types and actual numeric constraints', () => {
      for (const patch of [{ id: 9 }, { image_path: 'other/image.webp' }, { price: -1 },
        { price: '20' }, { visual_rating: 5.1 }, { visual_rating: 4.55 },
        { discount_active: true }, { discount_price: 20 }, { discount_price: 1.001 },
        { category_id: 'not-a-uuid' }, { available: null }]) {
        fails(auth() + call(5, { ...input, ...patch }), /Datos de producto invalidos/);
      }
      const offer = invoke(5, { ...input, discount_active: true, discount_price: 15, visual_rating: 4.5 });
      assert.equal(offer.product.discount_price, 15);
      assert.equal(offer.product.visual_rating, 4.5);
    });
    await t.test('RPC ACLs, unauthenticated callers and table privacy', () => {
      fails('set role anon;' + call(1), /permission denied for function/);
      fails(auth('', 'authenticated') + call(1), /Operacion no autorizada/);
      fails(auth(owner, 'service_role') + call(1), /permission denied for function/);
      for (const role of ['anon', 'authenticated', 'service_role']) {
        for (const statement of ['select * from public.product_creation_operations;',
          'delete from public.product_creation_operations;',
          'update public.product_creation_operations set product_id=null;',
          'insert into public.product_creation_operations default values;']) {
          fails(`set role ${role}; ${statement}`, /permission denied for table/);
        }
      }
      assert.equal(query("select prosecdef and proconfig @> array['search_path=\"\"'] from pg_proc where oid='public.create_product_idempotent(bigint,uuid,jsonb)'::regprocedure;"), 't');
    });
    await t.test('traditional insert and public view contract remain unchanged', () => {
      const id = query(auth() + "insert into public.products(store_id,name,price,active,available) values(1,'TRADITIONAL',3,true,true) returning id;");
      assert.ok(Number(id) > 0);
      const view = JSON.parse(query(auth() + `select row_to_json(v) from public.kafka_commerce_products v where id=${id};`));
      assert.equal(view.final_price, 3);
      assert.equal(view.image_path, null);
      assert.equal('operation_id' in view, false);
    });
    await t.test('two concurrent identical requests create exactly one product', async () => {
      const before = Number(count());
      let signal;
      const locked = new Promise((resolve) => { signal = resolve; });
      const writer = concurrent(`begin; ${auth()} ${call(20)} select 'CATALOG_LOCKED'; select pg_sleep(0.4); commit;`, signal);
      await Promise.race([locked, writer.then(() => { throw new Error('missing lock marker'); })]);
      const replies = await Promise.all([writer, concurrent(auth() + call(20))]);
      const results = replies.map((reply) => JSON.parse(reply.split('\n')[0]));
      assert.equal(results[0].product.id, results[1].product.id);
      assert.equal(results.filter((r) => r.replayed === false).length, 1);
      assert.equal(Number(count()), before + 1);
    });
    await t.test('a waiting incompatible request conflicts after the winner commits', async () => {
      let signal;
      const locked = new Promise((resolve) => { signal = resolve; });
      const writer = concurrent(`begin; ${auth()} ${call(21)} select 'CATALOG_LOCKED'; select pg_sleep(0.4); commit;`, signal);
      await Promise.race([locked, writer.then(() => { throw new Error('missing lock marker'); })]);
      const reader = concurrent(auth() + call(21, { ...input, price: 22 }));
      const results = await Promise.allSettled([writer, reader]);
      assert.equal(results[0].status, 'fulfilled');
      assert.equal(results[1].status, 'rejected');
      assert.match(results[1].reason.message, /Conflicto de operacion/);
      assert.equal(invoke(21).product.price, 20);
    });
    await t.test('a lost committed response can be recovered without another INSERT', () => {
      invoke(30); // Discard result as if the network response were lost.
      const before = count();
      assert.equal(invoke(30).replayed, true);
      assert.equal(invoke(30, null).status, 'found');
      assert.equal(count(), before);
    });
    await t.test('a rolled back transaction leaves no consumed operation', () => {
      const before = count();
      query(`begin; ${auth()} ${call(31)} rollback;`);
      assert.equal(count(), before);
      assert.equal(invoke(31, null).status, 'not_found');
      assert.equal(invoke(31).replayed, false);
    });
    await t.test('a product INSERT constraint failure also rolls back the operation', () => {
      query("alter table public.products add constraint local_insert_failure check(name <> 'REJECT_LOCAL');");
      const before = count();
      fails(auth() + call(32, { ...input, name: 'REJECT_LOCAL' }), /local_insert_failure/);
      assert.equal(count(), before);
      assert.equal(invoke(32, null).status, 'not_found');
      query('alter table public.products drop constraint local_insert_failure;');
      assert.equal(invoke(32).replayed, false);
    });
    await t.test('the composite reference prevents linking an operation to another tenant product', () => {
      const otherProduct = invoke(33, input, 2, other).product;
      fails(`update public.product_creation_operations set product_store_id=1, product_id=${otherProduct.id}
        where store_id=1 and operation_id=${quote(op(1))};`, /foreign key constraint/);
    });
    await t.test('refresh lookup not_found then late commit rejects changed payload with the SAME UUID', async () => {
      query('create table public.local_creation_commit_gate(released boolean); insert into public.local_creation_commit_gate values(false);');
      const before = Number(count());
      const pending = new Map();
      const storage = { getItem: (k) => pending.get(k) ?? null,
        setItem: (k, v) => pending.set(k, v), removeItem: (k) => pending.delete(k) };
      let signal;
      const locked = new Promise((resolve) => { signal = resolve; });
      const original = createProductCreationCoordinator(owner, 1, storage, async (id, payload) => {
        assert.equal(id, op(40));
        await concurrent(`begin; ${auth()} ${call(40, payload)} reset role;
          select 'CATALOG_LOCKED';
          do $$ declare released boolean := false; begin
            for i in 1..200 loop
              select g.released into released from public.local_creation_commit_gate g;
              exit when released; perform pg_sleep(0.02);
            end loop;
            if not released then raise exception 'local commit gate timeout'; end if;
          end $$; commit;`, signal);
        throw new Error('lost response after late commit');
      }, () => op(40));
      const lost = assert.rejects(original.create(input), /lost response/);
      try {
        await Promise.race([locked, lost.then(() => { throw new Error('original request ended before lock marker'); })]);
        const refreshed = createProductCreationCoordinator(owner, 1, storage, async (id, payload) => {
          assert.equal(id, op(40));
          return JSON.parse(await concurrent(auth() + call(40, payload)));
        }, () => { throw new Error('refresh must not generate another UUID'); });
        assert.equal(await refreshed.recover(), null);
        assert.deepEqual([...pending.values()], [op(40)]);
        assert.equal(Number(count()), before); // Original INSERT is still uncommitted.
        query('update public.local_creation_commit_gate set released=true;');
        await assert.rejects(refreshed.create({ ...input, price: 21 }), /Conflicto de operacion/);
        assert.deepEqual([...pending.values()], [op(40)]);
        assert.equal((await refreshed.recover()).price, 20);
        assert.equal(Number(count()), before + 1);
        assert.equal(query(`select count(*) from public.product_creation_operations where operation_id=${quote(op(40))};`), '1');
      } finally {
        query('update public.local_creation_commit_gate set released=true;');
        await lost;
      }
    });
    await t.test('confirmed product survives image_path UPDATE failure and retry uses its same ID', async () => {
      const before = Number(count());
      const pending = new Map(); let createCalls = 0;
      const storage = { getItem: (k) => pending.get(k) ?? null,
        setItem: (k, v) => pending.set(k, v), removeItem: (k) => pending.delete(k) };
      const creation = createProductCreationCoordinator(owner, 1, storage, async (id, payload) => {
        assert.equal(id, op(41)); createCalls++;
        return JSON.parse(await concurrent(auth() + call(41, payload)));
      }, () => op(41));
      const confirmed = await creation.create(input);
      // Start after upload: a candidate path exists. No Storage API is called.
      const path = '1-local/products/local-candidate.webp';
      query(`alter table public.products add constraint local_image_link_failure check(image_path is distinct from ${quote(path)});`);
      try {
        fails(auth() + `update public.products set image_path=${quote(path)} where store_id=1 and id=${confirmed.id};`, /local_image_link_failure/);
        assert.equal(Number(count()), before + 1);
        assert.equal(query(`select image_path is null from public.products where id=${confirmed.id};`), 't');
      } finally { query('alter table public.products drop constraint local_image_link_failure;'); }
      query(auth() + `update public.products set name='RETRY EDIT', image_path=${quote(path)} where store_id=1 and id=${confirmed.id};`);
      assert.equal(invoke(41).product.id, confirmed.id);
      assert.equal(invoke(41).product.image_path, path);
      assert.equal(Number(count()), before + 1);
      assert.equal(createCalls, 1);
    });
    await t.test('actual page validator outputs are accepted by the real RPC', () => {
      const categoryId = query("select id from public.categories where store_id=1 limit 1;");
      const form = { name: ' VALIDATED ', description: '', price: '100000001',
        discount_active: true, discount_price: '99999999.99', visual_rating: '4.55',
        category_id: categoryId, available: true };
      const cases = [form, { ...form, price: '1.001', discount_price: '0.29' },
        { ...form, price: '0', discount_active: false, discount_price: '', category_id: '', visual_rating: '0' }];
      cases.forEach((candidate, index) => {
        const parsed = parseProductForm(candidate, [{ id: categoryId, store_id: 1 }], 1);
        assert.ok('value' in parsed);
        const result = invoke(50 + index, parsed.value);
        assert.equal(result.status, 'found');
        assert.equal(result.product.price, parsed.value.price);
        assert.equal(result.product.visual_rating, parsed.value.visual_rating);
        assert.equal(result.product.category_id, parsed.value.category_id);
      });
    });
  } finally {
    if (started) run('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']);
    rmSync(root, { recursive: true, force: true });
  }
});
