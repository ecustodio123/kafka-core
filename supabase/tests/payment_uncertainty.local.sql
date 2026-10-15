-- Assertions for the disposable PostgreSQL fixture in payment-uncertainty.sql.test.mjs.
-- Never run against an application database or Supabase.
create function public.make_payment_fixture(p_3ds boolean default false)
returns uuid language plpgsql as $$
declare
  order_id uuid := gen_random_uuid();
  attempt_id uuid := gen_random_uuid();
begin
  insert into public.orders (id, store_id, customer_name, customer_phone, customer_email,
    status, subtotal_amount_cents, total_amount_cents)
  values (order_id, 1, 'LOCAL TEST', '000000000', 'test@example.com', 'pending_payment', 1299, 1299);
  insert into public.payment_attempts (id, store_id, order_id, status, amount_cents,
    idempotency_key, requires_3ds, three_ds_status, three_ds_device_fingerprint_hash)
  values (attempt_id, 1, order_id, 'processing', 1299, attempt_id::text,
    p_3ds, case when p_3ds then 'required' else null end,
    case when p_3ds then encode(extensions.digest('8019959c-fab1-49eb-bbbe-b846d308d8df', 'sha256'), 'hex') else null end);
  return attempt_id;
end;
$$;

create function public.expect_payment_error(p_sql text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when raise_exception then
    return;
  end;
  raise exception 'expected rejection';
end;
$$;

insert into public.stores values (1, null), (2, null);

do $$
declare
  a uuid := public.make_payment_fixture();
  b uuid;
  attempt public.payment_attempts%rowtype;
  result jsonb;
  event_count bigint;
  replay jsonb;
begin
  perform public.expect_payment_error(format(
    'select public.record_kafka_payment_attempt_uncertainty(2, %L, %L)', a, 'culqi_timeout'));
  perform public.expect_payment_error(format(
    'select public.record_kafka_payment_attempt_uncertainty(1, %L, %L)', gen_random_uuid(), 'culqi_timeout'));
  perform public.expect_payment_error(format(
    'select public.record_kafka_payment_attempt_uncertainty(1, %L, %L)', a, 'sk_test_forbidden'));
  perform public.expect_payment_error(format(
    'select public.record_kafka_payment_attempt_uncertainty(1, %L, %L, %L)', a, 'culqi_timeout', 'tkn_test_forbidden'));

  update public.payment_attempts set status = 'created' where id = a;
  perform public.expect_payment_error(format(
    'select public.record_kafka_payment_attempt_uncertainty(1, %L, %L)', a, 'culqi_timeout'));
  update public.payment_attempts set status = 'processing' where id = a;

  result := public.record_kafka_payment_attempt_uncertainty(1, a, 'culqi_timeout', 'chr_test_reference');
  perform public.record_kafka_payment_attempt_uncertainty(1, a, 'culqi_timeout', 'chr_test_reference');
  select count(*) into event_count from public.payment_events where payment_attempt_id = a;
  if event_count <> 1 or result->>'status' <> 'processing'
    or result->>'order_status' <> 'pending_payment'
    or result->'reconciliation_required' <> 'true'::jsonb then
    raise exception 'uncertainty was not persisted idempotently';
  end if;
  perform public.expect_payment_error(format(
    'select public.record_kafka_payment_attempt_uncertainty(1, %L, %L, %L)', a, 'culqi_timeout', 'chr_test_other'));

  result := public.finalize_kafka_payment_attempt(1, a, 'paid', 'chr_test_reference',
    null, null, 'event-paid-local', 'chr_test_reference');
  select * into attempt from public.payment_attempts where id = a;
  if result->>'order_status' <> 'paid' or attempt.reconciliation_required
    or attempt.reconciliation_reason is not null or attempt.three_ds_status is not null then
    raise exception 'non-3DS terminal metadata inconsistent';
  end if;
  select count(*) into event_count from public.payment_events where payment_attempt_id = a;
  perform public.record_kafka_payment_attempt_uncertainty(1, a, 'culqi_network_error');
  perform public.finalize_kafka_payment_attempt(1, a, 'paid', 'chr_test_reference',
    null, null, 'event-paid-local', 'chr_test_reference');
  perform public.finalize_kafka_payment_attempt(1, a, 'failed');
  if (select count(*) from public.payment_events where payment_attempt_id = a) <> event_count
    or (select status from public.orders where id = attempt.order_id) <> 'paid' then
    raise exception 'duplicate or late event modified paid history';
  end if;

  b := public.make_payment_fixture(true);
  perform public.claim_kafka_payment_attempt_3ds_completion(1, b, '8019959c-fab1-49eb-bbbe-b846d308d8df');
  perform public.record_kafka_payment_attempt_uncertainty(1, b, 'culqi_3ds_timeout');
  result := public.finalize_kafka_payment_attempt(1, b, 'paid', 'chr_test_3dsconfirmed',
    null, null, null, null, '{"culqi_status":200,"three_ds_authenticated":true}');
  select * into attempt from public.payment_attempts where id = b;
  if attempt.three_ds_status is distinct from 'completion_processing' or attempt.three_ds_completed_at is not null
    or not attempt.reconciliation_required or result->>'three_ds_status' is distinct from 'completion_processing' then
    raise exception 'HTTP status and caller boolean treated as authentication proof';
  end if;
  if exists (select 1 from public.payment_events where payment_attempt_id = b
    and sanitized_payload ? 'three_ds_authenticated') then
    raise exception 'unsupported authentication conclusion logged';
  end if;
  replay := public.finalize_kafka_payment_attempt(1, b, 'paid', 'chr_test_3dsconfirmed');
  if replay is distinct from result then
    raise exception 'terminal replay omitted reconciliation metadata';
  end if;
  perform public.record_kafka_payment_attempt_uncertainty(1, b, 'culqi_3ds_timeout');
  if public.kafka_payment_attempt_reconciliation_response(b) is distinct from result then
    raise exception 'late uncertainty changed terminal 3DS metadata';
  end if;

  b := public.make_payment_fixture(true);
  perform public.claim_kafka_payment_attempt_3ds_completion(1, b, '8019959c-fab1-49eb-bbbe-b846d308d8df');
  perform public.finalize_kafka_payment_attempt(1, b, 'failed', null,
    'insufficient_funds', 'TEST rejection', null, null,
    '{"culqi_status":402,"three_ds_authenticated":false}');
  select * into attempt from public.payment_attempts where id = b;
  if attempt.three_ds_status is distinct from 'completion_processing' or attempt.three_ds_completed_at is not null
    or not attempt.reconciliation_required then
    raise exception 'charge decline incorrectly recorded as failed authentication';
  end if;
  perform public.expect_payment_error(format(
    'select public.finalize_kafka_payment_attempt(1, %L, %L, %L)', b, 'paid', 'chr_test_late'));

  -- A prior authentication observation remains intact even if the charge fails.
  b := public.make_payment_fixture(true);
  update public.payment_attempts set three_ds_status = 'completed',
    three_ds_completed_at = '2026-10-01T00:00:00Z', reconciliation_required = true,
    reconciliation_reason = 'manual_review' where id = b;
  perform public.finalize_kafka_payment_attempt(1, b, 'failed', null, 'insufficient_funds');
  select * into attempt from public.payment_attempts where id = b;
  if attempt.three_ds_status is distinct from 'completed'
    or attempt.three_ds_completed_at is distinct from '2026-10-01T00:00:00Z'::timestamptz
    or not attempt.reconciliation_required or attempt.reconciliation_reason <> 'manual_review' then
    raise exception 'charge failure erased prior authentication/audit state';
  end if;

  -- Metadata failures and unrelated review flags are not financial timeouts.
  b := public.make_payment_fixture();
  perform public.record_kafka_payment_attempt_uncertainty(1, b, 'culqi_metadata_failed', 'chr_test_metadata');
  perform public.finalize_kafka_payment_attempt(1, b, 'failed');
  select * into attempt from public.payment_attempts where id = b;
  if not attempt.reconciliation_required or attempt.reconciliation_reason <> 'culqi_metadata_failed'
    or attempt.provider_reference <> 'chr_test_metadata' then
    raise exception 'metadata alert or reference was lost';
  end if;
  if not exists (select 1 from public.payment_events where payment_attempt_id = b
    and sanitized_payload#>>'{finalization_audit,before,provider_reference}' = 'chr_test_metadata') then
    raise exception 'prior reference missing from financial audit';
  end if;

  -- Duplicate event responses must preserve metadata and reject conflicting charge IDs.
  b := public.make_payment_fixture(true);
  result := public.finalize_kafka_payment_attempt(1, b, 'paid', 'chr_test_duplicate',
    null, null, 'event-duplicate-013');
  replay := public.finalize_kafka_payment_attempt(1, b, 'paid', 'chr_test_duplicate',
    null, null, 'event-duplicate-013');
  if replay is distinct from result then
    raise exception 'event replay omitted reconciliation metadata';
  end if;
  perform public.expect_payment_error(format(
    'select public.finalize_kafka_payment_attempt(1,%L,%L,%L,null,null,%L)',
    b, 'paid', 'chr_test_different', 'event-duplicate-013'));
  perform public.expect_payment_error(format(
    'select public.finalize_kafka_payment_attempt(1,%L,%L,null,null,null,%L)',
    b, 'failed', 'event-duplicate-013'));
  perform public.expect_payment_error(format(
    'select public.finalize_kafka_payment_attempt(2,%L,%L,%L)', b, 'paid', 'chr_test_duplicate'));
  if (select count(*) from public.payment_events where payment_attempt_id = b) <> 1 then
    raise exception 'conflicting replay changed audit history';
  end if;
  perform public.expect_payment_error(format(
    'select public.finalize_kafka_payment_attempt(1,%L,%L,%L,null,null,null,null,%L::jsonb)',
    public.make_payment_fixture(), 'paid', 'chr_test_array', '[]'));

  -- Even a backend marker cannot bypass the persisted 3DS claim.
  b := public.make_payment_fixture(true);
  perform public.finalize_kafka_payment_attempt(1, b, 'paid', 'chr_test_unverified',
    null, null, null, null, '{"culqi_status":200,"three_ds_authenticated":true}');
  select * into attempt from public.payment_attempts where id = b;
  if attempt.three_ds_status is distinct from 'required' or attempt.three_ds_completed_at is not null
    or not attempt.reconciliation_required or attempt.reconciliation_reason <> '3ds_authentication_unverified' then
    raise exception 'unverified authentication marked completed';
  end if;

  -- A persisted claim and arbitrary sanitized payload are still not auth proof.
  b := public.make_payment_fixture(true);
  perform public.claim_kafka_payment_attempt_3ds_completion(1, b, '8019959c-fab1-49eb-bbbe-b846d308d8df');
  perform public.finalize_kafka_payment_attempt(1, b, 'paid', 'chr_test_missingproof',
    null, null, null, null, '{"culqi_status":200,"three_ds_authenticated":"true"}');
  select * into attempt from public.payment_attempts where id = b;
  if attempt.three_ds_status is distinct from 'completion_processing' or attempt.three_ds_completed_at is not null
    or not attempt.reconciliation_required then
    raise exception 'missing authentication evidence accepted';
  end if;

  if has_function_privilege('anon', 'public.record_kafka_payment_attempt_uncertainty(bigint,uuid,text,text)', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.record_kafka_payment_attempt_uncertainty(bigint,uuid,text,text)', 'EXECUTE')
    or has_function_privilege('anon', 'public.finalize_kafka_payment_attempt(bigint,uuid,public.kafka_payment_attempt_status,text,text,text,text,text,jsonb)', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.finalize_kafka_payment_attempt(bigint,uuid,public.kafka_payment_attempt_status,text,text,text,text,text,jsonb)', 'EXECUTE') then
    raise exception 'public payment write access';
  end if;
  if has_function_privilege('anon', 'public.kafka_payment_attempt_reconciliation_response(uuid)', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.kafka_payment_attempt_reconciliation_response(uuid)', 'EXECUTE') then
    raise exception 'public helper access';
  end if;
end;
$$;

-- Execute the private RPC as its intended caller, without direct table access.
select public.make_payment_fixture() as service_attempt \gset
set role service_role;
select public.record_kafka_payment_attempt_uncertainty(1, :'service_attempt', 'culqi_timeout');
reset role;
