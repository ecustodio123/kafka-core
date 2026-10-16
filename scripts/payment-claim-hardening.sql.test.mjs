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

test('015 isolated PostgreSQL: exclusive processing claim and reconciliation guard', { skip: !available }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'kafka-015-'));
  const data = join(root, 'data');
  const localEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PG')));
  const connection = ['-X', '-q', '-h', root, '-p', '55445', '-U', 'kafka_test', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At'];
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
      let output = ''; let error = ''; let signaled = false;
      const timer = setTimeout(() => { child.kill(); reject(new Error('local SQL timeout')); }, 10000);
      child.stdout.on('data', (chunk) => {
        output += chunk;
        if (!signaled && output.includes('LOCKED_015')) { signaled = true; onLocked?.(); }
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
  const claim = (id) => `select public.claim_kafka_payment_attempt_processing(1,${quote(id)});`;
  const allRows = `select md5(jsonb_build_array(
    (select jsonb_agg(o order by o.id) from public.orders o),
    (select jsonb_agg(a order by a.id) from public.payment_attempts a),
    (select jsonb_agg(e order by e.id) from public.payment_events e),
    (select jsonb_agg(s order by s.id) from public.order_payment_sessions s))::text);`;
  try {
    run('initdb', ['-D', data, '-U', 'kafka_test', '-A', 'trust', '--no-locale']);
    // Unique private Unix socket, no TCP listener, never uses a remote URL/env.
    run('pg_ctl', ['-D', data, '-l', join(root, 'server.log'), '-o', `-k ${root} -p 55445 -c listen_addresses=''`, '-w', 'start']);
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
      '009_order_payment_sessions', '010_validate_session_and_reserve_payment_attempt',
      '011_payment_3ds_metadata_and_status', '012_validate_payment_attempt_source',
      '013_payment_uncertainty_and_terminal_consistency', '014_prepare_payment_reconciliation']) {
      query(sql(`migrations/202610130${name}.sql`));
    }
    const migration = sql('migrations/202610130015_harden_payment_attempt_processing_claim.sql');
    await t.test('applying 015 changes no existing rows; reapplication is safe', () => {
      query(`insert into public.stores values (99,null);
        insert into public.orders(store_id,customer_name,customer_phone,status,subtotal_amount_cents,total_amount_cents)
        values(99,'LOCAL BEFORE 015','000','pending_payment',1299,1299);
        insert into public.payment_attempts(store_id,order_id,status,amount_cents,reconciliation_required,idempotency_key)
        select 99,id,'created',1299,true,gen_random_uuid()::text from public.orders where store_id=99;`);
      const before = query(allRows);
      query(migration);
      query(migration);
      assert.equal(query(allRows), before);
    });
    await t.test('SQL assertions: uncertain created, normal/terminal states, real reserve replay, tenant, ACL and response shape', () => {
      query(sql('tests/payment_claim_hardening.local.sql'));
    });
    await t.test('two simultaneous claims have exactly one winner and one processing event', async () => {
      const id = query('select public.make_claim_fixture();');
      const replies = await Promise.all([concurrent(claim(id)), concurrent(claim(id))]);
      const results = replies.map((reply) => JSON.parse(reply));
      assert.equal(results.filter((reply) => reply.acquired === true).length, 1);
      assert.equal(results.filter((reply) => reply.acquired === false && reply.reason === 'already_processing').length, 1);
      assert.equal(query(`select count(*) from public.payment_events where payment_attempt_id=${quote(id)};`), '1');
    });
    await t.test('a waiting claim observes the committed winner, not its old created snapshot', async () => {
      const id = query('select public.make_claim_fixture();');
      let signal;
      const locked = new Promise((resolve) => { signal = resolve; });
      const writer = concurrent(`begin; ${claim(id)} select 'LOCKED_015'; select pg_sleep(0.3); commit;`, signal);
      await Promise.race([locked, writer.then(() => { throw new Error('writer completed without lock marker'); })]);
      const reader = concurrent(claim(id));
      const replies = await Promise.all([writer, reader]);
      assert.equal(JSON.parse(replies[0].split('\n')[0]).acquired, true);
      assert.equal(JSON.parse(replies[1]).acquired, false);
      assert.equal(query(`select count(*) from public.payment_events where payment_attempt_id=${quote(id)};`), '1');
    });
    await t.test('concurrent claims of an uncertain created attempt are both read-only refusals', async () => {
      const id = query('select public.make_claim_fixture(true);');
      const before = query(allRows);
      const replies = await Promise.all([concurrent(claim(id)), concurrent(claim(id))]);
      assert.deepEqual(JSON.parse(replies[0]), JSON.parse(replies[1]));
      assert.equal(JSON.parse(replies[0]).acquired, false);
      assert.equal(JSON.parse(replies[0]).reason, 'reconciliation_required');
      assert.equal(query(allRows), before);
    });
    await t.test('reconciliation set while claim waits is checked under fresh row locks', async () => {
      const id = query('select public.make_claim_fixture();');
      let signal;
      const locked = new Promise((resolve) => { signal = resolve; });
      const writer = concurrent(`begin;
        select 1 from public.orders where id=(select order_id from public.payment_attempts where id=${quote(id)}) for update;
        update public.payment_attempts set reconciliation_required=true where id=${quote(id)};
        select 'LOCKED_015'; select pg_sleep(0.3); commit;`, signal);
      await Promise.race([locked, writer.then(() => { throw new Error('writer completed without lock marker'); })]);
      const reader = concurrent(claim(id));
      const replies = await Promise.all([writer, reader]);
      assert.equal(JSON.parse(replies[1]).reason, 'reconciliation_required');
      assert.equal(JSON.parse(replies[1]).acquired, false);
      assert.equal(query(`select status from public.payment_attempts where id=${quote(id)};`), 'created');
      assert.equal(query(`select count(*) from public.payment_events where payment_attempt_id=${quote(id)};`), '0');
    });
    await t.test('only service_role can execute claim RPC', () => {
      for (const role of ['anon', 'authenticated']) {
        const result = spawnSync('psql', connection, {
          input: `set role ${role}; select public.claim_kafka_payment_attempt_processing(1,gen_random_uuid());`,
          encoding: 'utf8', env: localEnv, timeout: 10000,
        });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /permission denied for function claim_kafka_payment_attempt_processing/);
      }
      const id = query('select public.make_claim_fixture(true);');
      assert.equal(JSON.parse(query(`set role service_role; ${claim(id)}`)).reason, 'reconciliation_required');
    });
  } finally {
    if (started) run('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']);
    rmSync(root, { recursive: true, force: true });
  }
});
