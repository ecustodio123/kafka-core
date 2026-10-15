-- Disposable PostgreSQL only, loaded after payment_uncertainty.local.sql.
-- Never execute this fixture against Supabase or application data.
create function public.make_reconciliation_fixture(p_3ds boolean default false)
returns uuid language plpgsql as $$
declare a uuid := public.make_payment_fixture(p_3ds);
begin
  update public.payment_attempts set provider_reference = 'chr_test_' || replace(a::text, '-', ''),
    reconciliation_required = true, reconciliation_reason = 'culqi_timeout' where id = a;
  return a;
end;
$$;

create function public.reconciliation_evidence(p_attempt uuid)
returns jsonb language sql as $$
  select jsonb_build_object('schema_version', 1, 'provider', 'culqi', 'environment', 'test',
    'charge_id', coalesce(a.culqi_charge_id, a.provider_reference), 'amount_cents', a.amount_cents,
    'currency', 'PEN', 'metadata', jsonb_build_object('kafka_store_id', a.store_id::text,
      'kafka_order_id', a.order_id::text, 'kafka_payment_attempt_id', a.id::text))
  from public.payment_attempts a where a.id = p_attempt;
$$;

create function public.call_reconciliation_fixture(p_attempt uuid, p_key uuid,
  p_patch jsonb default '{}'::jsonb, p_snapshot text default null)
returns jsonb language sql as $$
  select public.prepare_kafka_payment_reconciliation(a.store_id, a.order_id, a.id, p_key,
    coalesce(p_snapshot, public.get_kafka_payment_reconciliation_snapshot(a.store_id,a.order_id,a.id)->>'snapshot_hash'),
    public.reconciliation_evidence(a.id) || p_patch)
  from public.payment_attempts a where a.id = p_attempt;
$$;

create function public.expect_reconciliation_error(p_sql text, p_message text)
returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when raise_exception then
    if sqlerrm = p_message then return; end if;
    raise exception 'unexpected reconciliation error';
  end;
  raise exception 'expected reconciliation rejection';
end;
$$;

do $$
declare
  a uuid := public.make_reconciliation_fixture();
  b uuid := public.make_reconciliation_fixture();
  k uuid := gen_random_uuid();
  o uuid;
  snap text;
  before_rows text;
  result jsonb;
  evidence jsonb;
  patch jsonb;
  terminal_status text;
begin
  select order_id into o from public.payment_attempts where id=a;
  before_rows := (select jsonb_build_array(to_jsonb(x), to_jsonb(y))::text
    from public.orders x join public.payment_attempts y on y.order_id=x.id where y.id=a);
  result := public.call_reconciliation_fixture(a,k);
  if result->>'result' <> 'not_applied' or result->>'reason' <> 'pending_provider_confirmation'
    or result->'financial_transitions_enabled' <> 'false'::jsonb
    or result->'financial_state_modified' <> 'false'::jsonb then
    raise exception 'financially blocked receipt missing';
  end if;
  if before_rows is distinct from (select jsonb_build_array(to_jsonb(x),to_jsonb(y))::text
    from public.orders x join public.payment_attempts y on y.order_id=x.id where y.id=a)
    or public.call_reconciliation_fixture(a,k) is distinct from result
    or (select count(*) from public.payment_events where provider_event_id='kafka-reconcile-v1:'||k::text) <> 1 then
    raise exception 'reconciliation changed rows or duplicated audit';
  end if;
  if not exists (
    select 1 from public.payment_events e
    where e.provider_event_id='kafka-reconcile-v1:'||k::text
      and e.event_type='provider_response' and e.status_before=e.status_after
      and e.sanitized_payload->>'action'='prepare_reconciliation_v1'
      and e.sanitized_payload->>'event_origin'='internal_reconciliation_preparation'
      and e.sanitized_payload->'financial_evidence_verified'='false'::jsonb
  ) then
    raise exception 'internal audit incorrectly identified as verified provider evidence';
  end if;
  perform public.expect_reconciliation_error(format(
    'select public.call_reconciliation_fixture(%L,%L)', b,k), 'clave de reconciliacion en conflicto');
  perform public.expect_reconciliation_error(format(
    'select public.call_reconciliation_fixture(%L,%L,%L::jsonb)',a,k,'{"amount_cents":1300}'),
    'clave de reconciliacion en conflicto');

  snap := public.get_kafka_payment_reconciliation_snapshot(1,o,a)->>'snapshot_hash';
  evidence := public.reconciliation_evidence(a);
  perform public.expect_reconciliation_error(format(
    'select public.prepare_kafka_payment_reconciliation(1,%L,%L,null,%L,%L::jsonb)',
    o,a,snap,evidence), 'solicitud de reconciliacion invalida');
  perform public.expect_reconciliation_error(format(
    'select public.call_reconciliation_fixture(%L,%L,%L::jsonb,%L)',a,gen_random_uuid(),'{}',repeat('f',64)),
    'snapshot de reconciliacion obsoleto');
  perform public.expect_reconciliation_error(format(
    'select public.prepare_kafka_payment_reconciliation(2,%L,%L,%L,%L,%L::jsonb)',
    o,a,gen_random_uuid(),snap,jsonb_set(evidence,'{metadata,kafka_store_id}','"2"')),
    'recurso de reconciliacion invalido');
  if public.get_kafka_payment_reconciliation_snapshot(2,o,a) is not null then
    raise exception 'cross-tenant snapshot exposed';
  end if;
  patch := jsonb_set(evidence,'{metadata,kafka_order_id}',to_jsonb(gen_random_uuid()::text));
  perform public.expect_reconciliation_error(format(
    'select public.prepare_kafka_payment_reconciliation(1,%L,%L,%L,%L,%L::jsonb)',
    patch#>>'{metadata,kafka_order_id}',a,gen_random_uuid(),snap,patch), 'recurso de reconciliacion invalido');
  patch := jsonb_set(evidence,'{metadata,kafka_payment_attempt_id}',to_jsonb(gen_random_uuid()::text));
  perform public.expect_reconciliation_error(format(
    'select public.prepare_kafka_payment_reconciliation(1,%L,%L,%L,%L,%L::jsonb)',
    o,patch#>>'{metadata,kafka_payment_attempt_id}',gen_random_uuid(),snap,patch), 'recurso de reconciliacion invalido');

  for patch in select value from jsonb_array_elements('[
    {"capture":true}, {"canFinalizePaid":true}, {"source_id":"forbidden"},
    {"authentication_3DS":{}}, {"schema_version":null}, {"environment":"live"},
    {"provider":"other"}, {"currency":"USD"}, {"metadata":[]},
    {"charge_id":"chr_live_invalid"}, {"charge_id":"chr_test_abc/def"},
    {"charge_id":"chr_test_abc\n"}, {"amount_cents":"1299"}, {"paid":true}
  ]'::jsonb) loop
    perform public.expect_reconciliation_error(format(
      'select public.call_reconciliation_fixture(%L,%L,%L::jsonb)',a,gen_random_uuid(),patch),
      'evidencia de reconciliacion invalida');
  end loop;
  perform public.expect_reconciliation_error(format(
    'select public.call_reconciliation_fixture(%L,%L,%L::jsonb)',a,gen_random_uuid(),'{"amount_cents":1300}'),
    'importe de reconciliacion incompatible');
  perform public.expect_reconciliation_error(format(
    'select public.call_reconciliation_fixture(%L,%L,%L::jsonb)',a,gen_random_uuid(),'{"charge_id":"chr_test_other"}'),
    'referencia de reconciliacion incompatible');

  -- Snapshot covers fields even when an UPDATE does not advance updated_at.
  update public.payment_attempts set reconciliation_reason='manual_review' where id=a;
  perform public.expect_reconciliation_error(format(
    'select public.call_reconciliation_fixture(%L,%L,%L::jsonb,%L)',a,gen_random_uuid(),'{}',snap),
    'snapshot de reconciliacion obsoleto');

  -- Exact replay remains a historical receipt after another RPC finalizes the order.
  update public.payment_attempts set reconciliation_reason='culqi_timeout' where id=a;
  perform public.finalize_kafka_payment_attempt(1,a,'paid',evidence->>'charge_id');
  if public.prepare_kafka_payment_reconciliation(1,o,a,k,snap,evidence) is distinct from result then
    raise exception 'historical receipt changed after finalization';
  end if;
  before_rows := (select jsonb_build_array(to_jsonb(x),to_jsonb(y))::text
    from public.orders x join public.payment_attempts y on y.order_id=x.id where y.id=a);
  perform public.call_reconciliation_fixture(a,gen_random_uuid());
  if before_rows is distinct from (select jsonb_build_array(to_jsonb(x),to_jsonb(y))::text
    from public.orders x join public.payment_attempts y on y.order_id=x.id where y.id=a) then
    raise exception 'paid order was modified';
  end if;

  -- Failed, expired and cancelled records and 3DS claims are never reopened/cleared.
  perform public.finalize_kafka_payment_attempt(1,b,'failed');
  before_rows := (select to_jsonb(x)::text from public.payment_attempts x where id=b);
  perform public.call_reconciliation_fixture(b,gen_random_uuid());
  if before_rows is distinct from (select to_jsonb(x)::text from public.payment_attempts x where id=b) then
    raise exception 'failed attempt modified';
  end if;
  a := public.make_reconciliation_fixture(true);
  perform public.claim_kafka_payment_attempt_3ds_completion(1,a,'8019959c-fab1-49eb-bbbe-b846d308d8df');
  before_rows := (select to_jsonb(x)::text from public.payment_attempts x where id=a);
  perform public.call_reconciliation_fixture(a,gen_random_uuid());
  if before_rows is distinct from (select to_jsonb(x)::text from public.payment_attempts x where id=a) then
    raise exception '3DS claim or uncertainty flags modified';
  end if;

  foreach terminal_status in array array['expired','cancelled'] loop
    a := public.make_reconciliation_fixture();
    select order_id into o from public.payment_attempts where id=a;
    update public.orders set status='cancelled' where id=o;
    update public.payment_attempts set status=terminal_status::public.kafka_payment_attempt_status where id=a;
    before_rows := (select jsonb_build_array(to_jsonb(x),to_jsonb(y))::text
      from public.orders x join public.payment_attempts y on y.order_id=x.id where y.id=a);
    perform public.call_reconciliation_fixture(a,gen_random_uuid());
    if before_rows is distinct from (select jsonb_build_array(to_jsonb(x),to_jsonb(y))::text
      from public.orders x join public.payment_attempts y on y.order_id=x.id where y.id=a) then
      raise exception 'expired/cancelled terminal changed';
    end if;
  end loop;

  -- A paid order can have historical nonpaid attempts. Preserve that valid history.
  a := public.make_reconciliation_fixture();
  select order_id into o from public.payment_attempts where id=a;
  perform public.finalize_kafka_payment_attempt(1,a,'paid',public.reconciliation_evidence(a)->>'charge_id');
  b := gen_random_uuid();
  insert into public.payment_attempts(id,store_id,order_id,status,amount_cents,idempotency_key,provider_reference)
  values(b,1,o,'created',1299,b::text,'chr_test_historical');
  perform public.call_reconciliation_fixture(b,gen_random_uuid());
  if (select status from public.payment_attempts where id=b) <> 'created'
    or (select status from public.orders where id=o) <> 'paid' then
    raise exception 'valid paid order history modified';
  end if;

  a := public.make_reconciliation_fixture();
  select order_id into o from public.payment_attempts where id=a;
  update public.orders set status='paid' where id=o;
  perform public.expect_reconciliation_error(format('select public.call_reconciliation_fixture(%L,%L)',a,gen_random_uuid()),
    'estado de reconciliacion incompatible');

  a := public.make_reconciliation_fixture();
  select order_id into o from public.payment_attempts where id=a;
  update public.orders set status='cancelled' where id=o;
  perform public.expect_reconciliation_error(format('select public.call_reconciliation_fixture(%L,%L)',a,gen_random_uuid()),
    'estado de reconciliacion incompatible');

  a := public.make_reconciliation_fixture();
  update public.payment_attempts set culqi_charge_id='chr_test_inconsistent' where id=a;
  perform public.expect_reconciliation_error(format('select public.call_reconciliation_fixture(%L,%L)',a,gen_random_uuid()),
    'referencia de reconciliacion incompatible');

  if has_function_privilege('anon','public.prepare_kafka_payment_reconciliation(bigint,uuid,uuid,uuid,text,jsonb)','EXECUTE')
    or has_function_privilege('authenticated','public.prepare_kafka_payment_reconciliation(bigint,uuid,uuid,uuid,text,jsonb)','EXECUTE')
    or has_function_privilege('anon','public.get_kafka_payment_reconciliation_snapshot(bigint,uuid,uuid)','EXECUTE')
    or has_function_privilege('authenticated','public.get_kafka_payment_reconciliation_snapshot(bigint,uuid,uuid)','EXECUTE') then
    raise exception 'public reconciliation access';
  end if;
  if not has_function_privilege('service_role','public.prepare_kafka_payment_reconciliation(bigint,uuid,uuid,uuid,text,jsonb)','EXECUTE') then
    raise exception 'service role lacks execute';
  end if;
end;
$$;

-- SECURITY DEFINER path works without direct table permissions for the caller.
select public.make_reconciliation_fixture() as service_attempt \gset
select order_id as service_order from public.payment_attempts where id=:'service_attempt' \gset
select public.get_kafka_payment_reconciliation_snapshot(1,:'service_order',:'service_attempt')->>'snapshot_hash' as service_snapshot \gset
select public.reconciliation_evidence(:'service_attempt') as service_evidence \gset
set role service_role;
select public.prepare_kafka_payment_reconciliation(1,:'service_order',:'service_attempt',
  '11111111-1111-4111-8111-111111111111',:'service_snapshot',:'service_evidence');
reset role;
