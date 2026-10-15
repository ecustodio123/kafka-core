import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const sql = (name) => readFileSync(new URL(`../supabase/${name}`, import.meta.url), 'utf8');
const available = ['initdb', 'pg_ctl', 'psql'].every((command) =>
  spawnSync(command, ['--version'], { stdio: 'ignore' }).status === 0);

test('013 actual PostgreSQL: uncertainty, terminal metadata and concurrent RPCs', { skip: !available }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'kafka-013-'));
  const data = join(root, 'data');
  const connection = ['-X', '-h', root, '-p', '55443', '-U', 'kafka_test', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'];
  let started = false;
  function run(command, args, input) {
    const result = spawnSync(command, args, { input, encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.stderr || `${command} failed`);
    return result.stdout;
  }
  function query(input) { return run('psql', [...connection, '-At'], input).trim(); }
  function concurrent(input) {
    return new Promise((resolve, reject) => {
      const child = spawn('psql', [...connection, '-At'], { stdio: ['pipe', 'pipe', 'pipe'] });
      let output = ''; let error = '';
      child.stdout.on('data', (chunk) => { output += chunk; });
      child.stderr.on('data', (chunk) => { error += chunk; });
      child.on('error', reject);
      child.on('close', (code) => code === 0 ? resolve(output.trim()) : reject(new Error(error)));
      child.stdin.end(input);
    });
  }
  try {
    run('initdb', ['-D', data, '-U', 'kafka_test', '-A', 'trust', '--no-locale']);
    run('pg_ctl', ['-D', data, '-l', join(root, 'server.log'), '-o', `-k ${root} -p 55443 -c listen_addresses=''`, '-w', 'start']);
    started = true;
    query(`create schema extensions; create schema vault; create schema auth;
      create role anon; create role authenticated; create role service_role;
      create table public.stores(id bigint primary key, owner_user_id uuid);
      create table public.products(id bigint, store_id bigint);
      create table vault.secrets(id uuid primary key);
      create function auth.uid() returns uuid language sql as 'select null::uuid';`);
    // Vault is not installed locally: only its FK target is needed by these RPCs.
    query(sql('migrations/202610130001_create_kafka_payments_v1.sql')
      .replace('create extension if not exists supabase_vault with schema vault;', ''));
    for (const name of ['006_reserve_payment_attempts', '008_claim_payment_attempt_processing',
      '009_order_payment_sessions', '011_payment_3ds_metadata_and_status',
      '012_validate_payment_attempt_source', '013_payment_uncertainty_and_terminal_consistency']) {
      query(sql(`migrations/202610130${name}.sql`));
    }
    query(sql('tests/payment_uncertainty.local.sql'));

    const snapshotSql = `select md5(jsonb_build_array(
      (select jsonb_agg(o order by o.id) from public.orders o),
      (select jsonb_agg(a order by a.id) from public.payment_attempts a),
      (select jsonb_agg(e order by e.id) from public.payment_events e))::text);`;
    const beforeReapply = query(snapshotSql);
    query(sql('migrations/202610130013_payment_uncertainty_and_terminal_consistency.sql'));
    assert.equal(query(snapshotSql), beforeReapply, 'applying 013 must not change existing data');

    const id = query('select public.make_payment_fixture();');
    const uncertain = `select public.record_kafka_payment_attempt_uncertainty(1, '${id}', 'culqi_timeout');`;
    await Promise.all([concurrent(uncertain), concurrent(uncertain)]);
    assert.equal(query(`select count(*) from public.payment_events where payment_attempt_id='${id}';`), '1');
    const finalize = `select public.finalize_kafka_payment_attempt(1, '${id}', 'paid', 'chr_test_race', null, null, 'event-race');`;
    await Promise.all([concurrent(uncertain), concurrent(finalize)]);
    await Promise.all([concurrent(finalize), concurrent(finalize)]);
    const state = JSON.parse(query(`select jsonb_build_object('attempt', a.status, 'order', o.status,
      'reconciliation', a.reconciliation_required) from public.payment_attempts a
      join public.orders o on o.id=a.order_id where a.id='${id}';`));
    assert.deepEqual(state, { attempt: 'paid', order: 'paid', reconciliation: false });
    assert.equal(query(`select count(*) from public.payment_events where payment_attempt_id='${id}';`), '2');

    const threeDsId = query('select public.make_payment_fixture(true);');
    query(`select public.claim_kafka_payment_attempt_3ds_completion(1, '${threeDsId}', '8019959c-fab1-49eb-bbbe-b846d308d8df');`);
    const threeDsFinalize = `select public.finalize_kafka_payment_attempt(1, '${threeDsId}', 'paid', 'chr_test_3dsrace', null, null, 'event-3ds-race', null, '{"culqi_status":200,"three_ds_authenticated":true}');`;
    const replies = await Promise.all([concurrent(threeDsFinalize), concurrent(threeDsFinalize)]);
    assert.deepEqual(JSON.parse(replies[0]), JSON.parse(replies[1]), 'concurrent finalizers must return identical metadata');
    const terminal = JSON.parse(replies[0]);
    assert.equal(terminal.status, 'paid');
    assert.equal(terminal.three_ds_status, 'completion_processing');
    assert.equal(terminal.three_ds_completed_at, null);
    assert.equal(terminal.reconciliation_required, true);
    const late = JSON.parse(query(`select public.record_kafka_payment_attempt_uncertainty(1, '${threeDsId}', 'culqi_3ds_timeout');`));
    assert.deepEqual(late, terminal);
    assert.equal(query(`select count(*) from public.payment_events where provider_event_id='event-3ds-race';`), '1');
  } finally {
    if (started) run('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']);
    rmSync(root, { recursive: true, force: true });
  }
});
