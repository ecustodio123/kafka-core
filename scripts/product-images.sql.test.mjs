import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const bin = process.env.CATALOG_PG_BIN ??
  (existsSync('/opt/homebrew/opt/postgresql@16/bin/initdb') ? '/opt/homebrew/opt/postgresql@16/bin' : null);
const exe = (name) => bin ? join(bin, name) : name;
const quote = (v) => `'${String(v).replaceAll("'", "''")}'`;
const read = (p) => readFileSync(new URL(`../supabase/${p}`, import.meta.url), 'utf8');
const auth = (owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') =>
  `set role authenticated; set request.jwt.claim.sub=${quote(owner)};`;

test('image linking: actual PostgreSQL CAS predicates, RLS and concurrent row locks', async (t) => {
  for (const tool of ['initdb', 'pg_ctl', 'psql']) assert.equal(spawnSync(exe(tool), ['--version'], { stdio: 'ignore' }).status, 0, `${tool} required; no skips`);
  const root = mkdtempSync(join(tmpdir(), 'kafka-images-'));
  const data = join(root, 'data');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PG')));
  const connection = ['-X', '-q', '-At', '-h', root, '-p', '55450', '-U', 'image_test', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'];
  let started = false;
  function run(cmd, args, input) {
    const r = spawnSync(exe(cmd), args, { input, encoding: 'utf8', timeout: 30000, env });
    assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
  }
  const query = (s) => run('psql', connection, s);
  function concurrent(sql, signal) {
    return new Promise((resolve, reject) => {
      const child = spawn(exe('psql'), connection, { env, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = ''; let errors = ''; let signaled = false;
      const timer = setTimeout(() => { child.kill(); reject(new Error('local concurrency timeout')); }, 10000);
      child.stdout.on('data', (part) => {
        output += part;
        if (!signaled && output.includes('IMAGE_LOCKED')) { signaled = true; signal?.(); }
      });
      child.stderr.on('data', (part) => { errors += part; });
      child.on('error', (err) => { clearTimeout(timer); reject(err); });
      child.on('close', (code) => { clearTimeout(timer); if (code === 0) resolve(output.trim()); else reject(new Error(errors)); });
      child.stdin.end(`set lock_timeout='4s'; set statement_timeout='6s'; ${sql}`);
    });
  }
  const create = (path = null) => query(auth() + `insert into public.products(store_id,name,price,image_path,available,active)
    values(1,'LOCAL IMAGE',20,${path === null ? 'null' : quote(path)},true,true) returning id;`);
  const cas = (id, expected, candidate) => `update public.products set image_path=${quote(candidate)}
    where store_id=1 and id=${id} and image_path ${expected === null ? 'is null' : `=${quote(expected)}`} returning id;`;
  try {
    run('initdb', ['-D', data, '-U', 'image_test', '-A', 'trust', '--no-locale']);
    run('pg_ctl', ['-D', data, '-l', join(root, 'server.log'), '-o', `-k ${root} -p 55450 -c listen_addresses=''`, '-w', 'start']); started = true;
    query(read('tests/product_creation.local.sql'));
    for (const p of ['phase-6-auth-rls.sql', 'migrations/202610080001_add_product_categories.sql',
      'migrations/202610100001_add_product_offers_rating.sql', 'migrations/202610160001_product_creation_idempotency.sql']) query(read(p));

    await t.test('NULL is an actual conditional predicate, not a read followed by unconditional UPDATE', () => {
      const id = create();
      assert.equal(query(auth() + cas(id, null, '1-store/products/local-a.webp')), id);
      assert.equal(query(auth() + cas(id, null, '1-store/products/local-b.webp')), '');
      assert.equal(query(`select image_path from public.products where id=${id};`), '1-store/products/local-a.webp');
    });
    await t.test('legacy paths and shared references remain valid; replacing one product does not alter the other', () => {
      const old = '1/10/image.webp'; const a = create(old); const b = create(old);
      assert.equal(query(auth() + cas(a, old, '1-store/products/new/principal-uuid.webp')), a);
      assert.equal(query(`select image_path from public.products where id=${b};`), old);
    });
    await t.test('a late or lost successful response is recognized by the persisted candidate', () => {
      const id = create('1/old.webp'); const candidate = '1-store/products/new.webp';
      query(auth() + cas(id, '1/old.webp', candidate)); // Discard the response.
      assert.equal(query(auth() + cas(id, '1/old.webp', candidate)), '');
      assert.equal(query(auth() + `select image_path from public.products where store_id=1 and id=${id};`), candidate);
    });
    await t.test('two real sessions: waiting UPDATE rechecks the old-path predicate after the winner commits', async () => {
      const id = create('1/old.webp'); let signal;
      const locked = new Promise((resolve) => { signal = resolve; });
      const writer = concurrent(`begin; ${auth()} ${cas(id, '1/old.webp', '1/new-a.webp')}
        select 'IMAGE_LOCKED'; select pg_sleep(0.4); commit;`, signal);
      await Promise.race([locked, writer.then(() => { throw new Error('missing row lock signal'); })]);
      const [a, b] = await Promise.all([writer, concurrent(auth() + cas(id, '1/old.webp', '1/new-b.webp'))]);
      assert.equal(a.split('\n')[0], id); assert.equal(b, '');
      assert.equal(query(`select image_path from public.products where id=${id};`), '1/new-a.webp');
    });
    await t.test('different owner or store cannot update or read the target product via RLS', () => {
      const id = create('1/old.webp');
      assert.equal(query(auth('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb') + cas(id, '1/old.webp', '2/attack.webp')), '');
      assert.equal(query(auth('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb') + `select id from public.products where id=${id};`), '');
      assert.equal(query(auth() + `update public.products set image_path='other' where id=${id} and store_id=2 returning id;`), '');
      assert.equal(query(`select image_path from public.products where id=${id};`), '1/old.webp');
    });
    await t.test('2A idempotent product creation remains compatible with conditional image linking and replay', () => {
      const payload = { name: 'LOCAL 2A', description: '', price: 10, discount_active: false,
        discount_price: null, visual_rating: 5, category_id: null, available: true };
      const call = `select public.create_product_idempotent(1,'aaaaaaaa-0000-4000-8000-000000000001',${quote(JSON.stringify(payload))}::jsonb);`;
      const first = JSON.parse(query(auth() + call));
      query(auth() + cas(first.product.id, null, '1-store/products/new-image.webp'));
      const replay = JSON.parse(query(auth() + call));
      assert.equal(replay.product.id, first.product.id);
      assert.equal(replay.product.image_path, '1-store/products/new-image.webp');
      assert.equal(replay.replayed, true);
    });
  } finally {
    if (started) run('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']);
    rmSync(root, { recursive: true, force: true });
  }
});
