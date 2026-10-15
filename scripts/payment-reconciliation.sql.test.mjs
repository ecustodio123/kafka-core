import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const sql = (name) => readFileSync(new URL(`../supabase/${name}`, import.meta.url), 'utf8');
const available = ['initdb', 'pg_ctl', 'psql'].every((command) =>
  spawnSync(command, ['--version'], { stdio: 'ignore' }).status === 0);
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;

test('014 isolated PostgreSQL: blocked reconciliation infrastructure', { skip: !available }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'kafka-014-'));
  const data = join(root, 'data');
  // Private Unix socket, NO TCP listener, explicit local user/database, no remote env.
  const connection = ['-X', '-q', '-h', root, '-p', '55444', '-U', 'kafka_test', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At'];
  // PGHOSTADDR/PGSERVICE/PGOPTIONS must not override the disposable local connection.
  const localEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PG')));
  let started = false;
  function run(command, args, input) {
    const result = spawnSync(command, args, { input, encoding: 'utf8', timeout: 30000, env: localEnv });
    assert.equal(result.status, 0, result.stderr || `${command} failed`);
    return result.stdout;
  }
  function query(input) { return run('psql', connection, input).trim(); }
  function concurrent(input, onLocked) {
    return new Promise((resolve, reject) => {
      const child = spawn('psql', connection, { stdio: ['pipe', 'pipe', 'pipe'], env: localEnv });
      let output = ''; let error = '';
      const timer = setTimeout(() => { child.kill(); reject(new Error('local SQL timeout')); }, 10000);
      child.stdout.on('data', (chunk) => {
        output += chunk;
        if (output.includes('LOCKED_014')) onLocked?.();
      });
      child.stderr.on('data', (chunk) => { error += chunk; });
      child.on('error', (err) => { clearTimeout(timer); reject(err); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(output.trim()); else reject(new Error(error));
      });
      child.stdin.end(`set lock_timeout='3s'; set statement_timeout='5s'; ${input}`);
    });
  }
  function fixture(threeDs = false) {
    const id = query(`select public.make_reconciliation_fixture(${threeDs});`);
    return JSON.parse(query(`select jsonb_build_object('id',a.id,'order',a.order_id,
      'snapshot',public.get_kafka_payment_reconciliation_snapshot(1,a.order_id,a.id)->>'snapshot_hash',
      'evidence',public.reconciliation_evidence(a.id)) from public.payment_attempts a where a.id=${quote(id)};`));
  }
  function prepare(f, key) {
    return `select public.prepare_kafka_payment_reconciliation(1,${quote(f.order)},${quote(f.id)},
      ${quote(key)},${quote(f.snapshot)},${quote(JSON.stringify(f.evidence))}::jsonb);`;
  }
  const snapshotAll = `select md5(jsonb_build_array(
    (select jsonb_agg(o order by o.id) from public.orders o),
    (select jsonb_agg(a order by a.id) from public.payment_attempts a),
    (select jsonb_agg(e order by e.id) from public.payment_events e))::text);`;
  try {
    run('initdb', ['-D', data, '-U', 'kafka_test', '-A', 'trust', '--no-locale']);
    run('pg_ctl', ['-D', data, '-l', join(root, 'server.log'), '-o', `-k ${root} -p 55444 -c listen_addresses=''`, '-w', 'start']);
    started = true;
    query(`create schema extensions; create schema vault; create schema auth;
      create role anon; create role authenticated; create role service_role;
      create table public.stores(id bigint primary key, owner_user_id uuid);
      create table public.products(id bigint, store_id bigint);
      create table vault.secrets(id uuid primary key);
      create function auth.uid() returns uuid language sql as 'select null::uuid';`);
    query(sql('migrations/202610130001_create_kafka_payments_v1.sql')
      .replace('create extension if not exists supabase_vault with schema vault;', ''));
    for (const name of ['006_reserve_payment_attempts', '008_claim_payment_attempt_processing',
      '009_order_payment_sessions', '011_payment_3ds_metadata_and_status',
      '012_validate_payment_attempt_source', '013_payment_uncertainty_and_terminal_consistency']) {
      query(sql(`migrations/202610130${name}.sql`));
    }
    query(sql('tests/payment_uncertainty.local.sql'));
    const migration = sql('migrations/202610130014_prepare_payment_reconciliation.sql');

    await t.test('applying/reapplying 014 changes no existing records', () => {
      const before = query(snapshotAll);
      query(migration);
      query(migration);
      assert.equal(query(snapshotAll), before);
    });
    await t.test('SQL assertions: tenant, amount, references, state, secrets, stale snapshot, terminal and ACL safety', () => {
      query(sql('tests/payment_reconciliation.local.sql'));
    });
    await t.test('concurrent identical requests insert one audit receipt without financial writes', async () => {
      const f = fixture();
      const key = '22222222-2222-4222-8222-222222222222';
      const before = query(`select to_jsonb(a)::text from public.payment_attempts a where id=${quote(f.id)};`);
      const replies = await Promise.all([concurrent(prepare(f,key)), concurrent(prepare(f,key))]);
      assert.deepEqual(JSON.parse(replies[0]), JSON.parse(replies[1]));
      assert.equal(JSON.parse(replies[0]).result, 'not_applied');
      assert.equal(query(`select count(*) from public.payment_events where provider_event_id='kafka-reconcile-v1:${key}';`), '1');
      assert.equal(query(`select to_jsonb(a)::text from public.payment_attempts a where id=${quote(f.id)};`), before);
    });
    await t.test('same key across different orders conflicts safely without a deadlock', async () => {
      const a = fixture(); const b = fixture();
      const key = '33333333-3333-4333-8333-333333333333';
      const replies = await Promise.allSettled([concurrent(prepare(a,key)), concurrent(prepare(b,key))]);
      assert.equal(replies.filter((reply) => reply.status === 'fulfilled').length, 1);
      assert.match(replies.find((reply) => reply.status === 'rejected').reason.message, /clave de reconciliacion en conflicto/);
      assert.equal(query(`select count(*) from public.payment_events where provider_event_id='kafka-reconcile-v1:${key}';`), '1');
    });
    await t.test('waiting behind finalize rechecks the fresh snapshot and never reopens paid', async () => {
      const f = fixture();
      let signal;
      const locked = new Promise((resolve) => { signal = resolve; });
      const writer = concurrent(`begin; select 1 from public.orders where id=${quote(f.order)} for update;
        select 'LOCKED_014'; select pg_sleep(0.3);
        select public.finalize_kafka_payment_attempt(1,${quote(f.id)},'paid',${quote(f.evidence.charge_id)}); commit;`, signal);
      await Promise.race([locked, writer.then(() => { throw new Error('writer completed without lock marker'); })]);
      const reader = concurrent(prepare(f,'44444444-4444-4444-8444-444444444444'));
      const replies = await Promise.allSettled([writer,reader]);
      assert.equal(replies[0].status,'fulfilled');
      assert.equal(replies[1].status,'rejected');
      assert.match(replies[1].reason.message,/snapshot de reconciliacion obsoleto/);
      assert.equal(query(`select status from public.orders where id=${quote(f.order)};`),'paid');
      assert.equal(query(`select count(*) from public.payment_events where provider_event_id='kafka-reconcile-v1:44444444-4444-4444-8444-444444444444';`),'0');
    });
    await t.test('racing 3DS claim preserves exclusive ownership and invalidates the old snapshot', async () => {
      const f = fixture(true);
      const results = await Promise.allSettled([
        concurrent(`select public.claim_kafka_payment_attempt_3ds_completion(1,${quote(f.id)},'8019959c-fab1-49eb-bbbe-b846d308d8df');`),
        concurrent(prepare(f,'55555555-5555-4555-8555-555555555555')),
      ]);
      assert.equal(results[0].status,'fulfilled');
      assert.equal(JSON.parse(results[0].value).acquired,true);
      if (results[1].status === 'fulfilled') assert.equal(JSON.parse(results[1].value).result,'not_applied');
      else assert.match(results[1].reason.message,/snapshot de reconciliacion obsoleto/);
      const row = JSON.parse(query(`select jsonb_build_object('status',status,'three_ds_status',three_ds_status,
        'reconciliation_required',reconciliation_required,'completed',three_ds_completed_at)
        from public.payment_attempts where id=${quote(f.id)};`));
      assert.deepEqual(row,{ status:'processing',three_ds_status:'completion_processing',reconciliation_required:true,completed:null });
      assert.equal(JSON.parse(query(`select public.claim_kafka_payment_attempt_3ds_completion(1,${quote(f.id)},'8019959c-fab1-49eb-bbbe-b846d308d8df');`)).acquired,false);
    });
  } finally {
    if (started) run('pg_ctl',['-D',data,'-m','fast','-w','stop']);
    rmSync(root,{ recursive:true,force:true });
  }
});
