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

test('016 isolated PostgreSQL: atomic session authorization and payment claims', { skip: !available }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'kafka-016-'));
  const data = join(root, 'data');
  const localEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PG')));
  const connection = ['-X', '-q', '-h', root, '-p', '55446', '-U', 'kafka_test', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At'];
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
        if (!signaled && output.includes('LOCKED_016')) { signaled = true; onLocked?.(); }
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
  const claim = (f) => `select public.call_session_claim_fixture(${quote(JSON.stringify(f))}::jsonb);`;
  const allRows = `select md5(jsonb_build_array(
    (select jsonb_agg(o order by o.id) from public.orders o),
    (select jsonb_agg(a order by a.id) from public.payment_attempts a),
    (select jsonb_agg(e order by e.id) from public.payment_events e),
    (select jsonb_agg(s order by s.id) from public.order_payment_sessions s))::text);`;
  try {
    run('initdb', ['-D', data, '-U', 'kafka_test', '-A', 'trust', '--no-locale']);
    // Unique private Unix socket, no TCP listener, never uses a remote URL/env.
    run('pg_ctl', ['-D', data, '-l', join(root, 'server.log'), '-o', `-k ${root} -p 55446 -c listen_addresses=''`, '-w', 'start']);
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
      '013_payment_uncertainty_and_terminal_consistency', '014_prepare_payment_reconciliation', '015_harden_payment_attempt_processing_claim']) {
      query(sql(`migrations/202610130${name}.sql`));
    }
    const migration = sql('migrations/202610130016_authorize_session_and_claim.sql');
    query(migration);
    query(sql('tests/payment_session_claim.local.sql'));
    await t.test('reapplying 016 preserves all rows; SQL assertions passed on real PostgreSQL', () => {
      const before = query(allRows);
      query(migration);
      assert.equal(query(allRows), before);
    });
    for (const threeDs of [false, true]) {
      const fixture = () => JSON.parse(query(`select public.make_session_claim_fixture(${threeDs});`));
      const eventCount = (f) => query(`select count(*) from public.payment_events where order_id=${quote(f.order)};`);
      const state = (f) => query(`select public.session_claim_state(${quote(f.order)});`);
      await t.test(`${threeDs ? '3DS' : 'initial'} simultaneous claims: exactly one winner and one event`, async () => {
        const f = fixture(); const before = Number(eventCount(f));
        const replies = (await Promise.all([concurrent(claim(f)), concurrent(claim(f))])).map(JSON.parse);
        assert.equal(replies.filter((r) => r.acquired === true).length, 1);
        assert.equal(replies.filter((r) => r.acquired === false && r.reason === 'already_processing').length, 1);
        assert.equal(Number(eventCount(f)), before + 1);
      });
      await t.test(`${threeDs ? '3DS' : 'initial'} revocation committed while claim waits prevents acquisition`, async () => {
        const f = fixture();
        let signal; const locked = new Promise((resolve) => { signal = resolve; });
        const writer = concurrent(`begin; select public.revoke_order_payment_sessions(1,${quote(f.order)});
          select 'LOCKED_016'; select pg_sleep(0.3); commit;`, signal);
        await Promise.race([locked, writer.then(() => { throw new Error('lock marker missing'); })]);
        const reader = concurrent(claim(f));
        const replies = await Promise.all([writer,reader]);
        assert.deepEqual(JSON.parse(replies[1]), { acquired:false, authorized:false, reason:'invalid_session' });
        assert.equal(query(`select count(*) from public.payment_events where order_id=${quote(f.order)} and sanitized_payload->>'action' in ('claim_payment_attempt_processing','claim_3ds_completion');`), threeDs ? '1' : '0');
      });
      await t.test(`${threeDs ? '3DS' : 'initial'} expires during lock wait: wall clock denies with zero mutation`, async () => {
        const f = fixture();
        query(`update public.order_payment_sessions set expires_at=clock_timestamp()+interval '0.7 second' where order_id=${quote(f.order)};`);
        const before = state(f);
        let signal; const locked = new Promise((resolve) => { signal = resolve; });
        const writer = concurrent(`begin; select 1 from public.orders where id=${quote(f.order)} for update;
          select 'LOCKED_016'; select pg_sleep(1.1); commit;`, signal);
        await Promise.race([locked, writer.then(() => { throw new Error('lock marker missing'); })]);
        const reader = concurrent(`begin;
          select transaction_timestamp() < expires_at from public.order_payment_sessions where order_id=${quote(f.order)};
          ${claim(f)} commit;`);
        const replies = await Promise.all([writer,reader]);
        const lines = replies[1].split('\n');
        assert.equal(lines[0], 't', 'the transaction started while the session was still unexpired');
        assert.equal(JSON.parse(lines[1]).authorized, false);
        assert.equal(state(f), before);
      });
      await t.test(`${threeDs ? '3DS' : 'initial'} reserve replay and claim serialize without inverse advisory locks`, async () => {
        const f = fixture();
        const hash = quote(query(`select public.session_claim_hash(${quote(f.order)});`));
        const reserve = `select public.validate_order_payment_session_and_reserve_attempt(1,${quote(f.order)},${hash},${quote(f.key)},'tkn_test_localfixture');`;
        const replies = await Promise.all([concurrent(reserve), concurrent(claim(f))]);
        assert.equal(JSON.parse(replies[0]).valid,true);
        assert.equal(JSON.parse(replies[1]).acquired,true);
      });
      await t.test(`${threeDs ? '3DS' : 'initial'} claim committed before revocation remains owned; no second claim`, async () => {
        const f = fixture();
        assert.equal(JSON.parse(query(claim(f))).acquired, true);
        query(`select public.revoke_order_payment_sessions(1,${quote(f.order)});`);
        const before = state(f);
        assert.equal(JSON.parse(query(claim(f))).acquired, false);
        assert.equal(state(f), before);
        assert.equal(query(`select status from public.payment_attempts where id=${quote(f.attempt)};`), 'processing');
      });
      await t.test(`${threeDs ? '3DS' : 'initial'} real service role executes; public roles cannot`, () => {
        const f = fixture();
        const hash = quote(query(`select public.session_claim_hash(${quote(f.order)});`));
        const direct = threeDs
          ? `select public.claim_payment_3ds_for_session(1,${quote(f.order)},${quote(f.attempt)},${hash},'tkn_test_localfixture','8019959c-fab1-49eb-bbbe-b846d308d8df');`
          : `select public.claim_payment_attempt_for_session(1,${quote(f.order)},${quote(f.attempt)},${hash},${quote(f.key)},'tkn_test_localfixture');`;
        for (const role of ['anon','authenticated']) {
          const r = spawnSync('psql',connection,{input:`set role ${role}; ${direct}`,encoding:'utf8',env:localEnv,timeout:10000});
          assert.notEqual(r.status,0); assert.match(r.stderr,/permission denied for function claim_payment_/);
        }
        assert.equal(JSON.parse(query(`set role service_role; ${direct}`)).acquired,true);
      });
    }
  } finally {
    if (started) run('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']);
    rmSync(root, { recursive: true, force: true });
  }
});
