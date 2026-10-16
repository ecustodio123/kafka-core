-- Disposable PostgreSQL ONLY. Never run fixtures on Supabase/application data.
insert into public.stores values (1, null), (2, null);
insert into vault.secrets(id) values ('11111111-1111-4111-8111-111111111111');
insert into public.store_payment_settings (
  store_id, active, culqi_enabled, culqi_public_key, culqi_private_key_secret_id
) values (1, true, true, 'pk_test_localfixture', '11111111-1111-4111-8111-111111111111');

create function public.make_claim_fixture(p_reconciliation boolean default false)
returns uuid language plpgsql as $$
declare o uuid := gen_random_uuid(); a uuid := gen_random_uuid();
begin
  insert into public.orders (id, store_id, customer_name, customer_phone, customer_email,
    status, subtotal_amount_cents, total_amount_cents)
  values (o, 1, 'LOCAL CLAIM TEST', '000000000', 'test@example.com', 'pending_payment', 1299, 1299);
  insert into public.payment_attempts (id, store_id, order_id, status, amount_cents,
    idempotency_key, reconciliation_required)
  values (a, 1, o, 'created', 1299, a::text, p_reconciliation);
  return a;
end;
$$;

create function public.expect_claim_error(p_sql text, p_message text)
returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when raise_exception then
    if sqlerrm = p_message then return; end if;
    raise exception 'unexpected claim error';
  end;
  raise exception 'expected claim rejection';
end;
$$;

do $$
declare
  a uuid := public.make_claim_fixture(true);
  b uuid;
  o uuid;
  result jsonb;
  before_rows jsonb;
  s text;
  flag boolean;
  reserved jsonb;
begin
  select jsonb_build_array(to_jsonb(x),to_jsonb(y)) into before_rows
  from public.orders x join public.payment_attempts y on x.id=y.order_id where y.id=a;
  result := public.claim_kafka_payment_attempt_processing(1,a);
  if result->'acquired' is distinct from 'false'::jsonb
    or result->>'reason' is distinct from 'reconciliation_required'
    or result is distinct from public.claim_kafka_payment_attempt_processing(1,a)
    or exists(select 1 from public.payment_events where payment_attempt_id=a)
    or before_rows is distinct from (select jsonb_build_array(to_jsonb(x),to_jsonb(y))
      from public.orders x join public.payment_attempts y on x.id=y.order_id where y.id=a) then
    raise exception 'uncertain created claim changed state or audit';
  end if;
  if result->'payment_attempt' ?| array['requires_3ds','three_ds_status','reconciliation_required','three_ds_completed_at'] then
    raise exception 'claim response unexpectedly extended the base contract';
  end if;

  b := public.make_claim_fixture();
  result := public.claim_kafka_payment_attempt_processing(1,b);
  if result->'acquired' is distinct from 'true'::jsonb
    or result->>'reason' is distinct from 'claimed'
    or result->'payment_attempt'->>'status' is distinct from 'processing'
    or (select count(*) from public.payment_events where payment_attempt_id=b) <> 1 then
    raise exception 'normal claim did not transition once';
  end if;
  result := public.claim_kafka_payment_attempt_processing(1,b);
  if result->'acquired' is distinct from 'false'::jsonb
    or result->>'reason' is distinct from 'already_processing'
    or (select count(*) from public.payment_events where payment_attempt_id=b) <> 1 then
    raise exception 'claim replay processed twice';
  end if;

  foreach s in array array['processing','paid','failed','expired','cancelled'] loop
    foreach flag in array array[false,true] loop
      b := public.make_claim_fixture(flag);
      update public.payment_attempts set status=s::public.kafka_payment_attempt_status where id=b;
      result := public.claim_kafka_payment_attempt_processing(1,b);
      if result->'acquired' is distinct from 'false'::jsonb
        or result->>'reason' is distinct from (case when s='processing' then 'already_processing' else 'terminal_state' end)
        or (select status::text from public.payment_attempts where id=b) <> s
        or exists(select 1 from public.payment_events where payment_attempt_id=b) then
        raise exception 'processing/terminal behavior changed';
      end if;
    end loop;
  end loop;

  perform public.expect_claim_error(format('select public.claim_kafka_payment_attempt_processing(2,%L)',a), 'intento de pago invalido');
  perform public.expect_claim_error(format('select public.claim_kafka_payment_attempt_processing(1,%L)',gen_random_uuid()), 'intento de pago invalido');
  b := public.make_claim_fixture();
  update public.payment_attempts set amount_cents=1300 where id=b;
  perform public.expect_claim_error(format('select public.claim_kafka_payment_attempt_processing(1,%L)',b), 'intento de pago inconsistente con la orden');

  -- Real 010 -> 006 replay validates fingerprints but returns ONLY base fields.
  o := gen_random_uuid();
  insert into public.orders(id,store_id,customer_name,customer_phone,customer_email,status,subtotal_amount_cents,total_amount_cents)
  values(o,1,'LOCAL RESERVE TEST','000000000','test@example.com','pending_payment',1299,1299);
  insert into public.order_payment_sessions(store_id,order_id,token_hash,expires_at)
  values(1,o,repeat('a',64),now()+interval '15 minutes');
  reserved := public.validate_order_payment_session_and_reserve_attempt(1,o,repeat('a',64),o::text,'tkn_test_localfixture');
  b := (reserved->'payment_attempt'->>'id')::uuid;
  update public.payment_attempts set reconciliation_required=true where id=b;
  reserved := public.validate_order_payment_session_and_reserve_attempt(1,o,repeat('a',64),o::text,'tkn_test_localfixture');
  if reserved->'valid' is distinct from 'true'::jsonb
    or reserved->'existing_attempt' is distinct from 'true'::jsonb
    or reserved->'payment_attempt'->>'id' <> b::text
    or reserved->'payment_attempt' ? 'reconciliation_required' then
    raise exception 'reservation replay/base response mismatch';
  end if;
  result := public.claim_kafka_payment_attempt_processing(1,b);
  if result->>'reason' is distinct from 'reconciliation_required'
    or result->'acquired' is distinct from 'false'::jsonb
    or (select count(*) from public.payment_events where payment_attempt_id=b) <> 1 then
    raise exception 'replayed reservation bypassed reconciliation guard';
  end if;
  perform public.expect_claim_error(format(
    'select public.validate_order_payment_session_and_reserve_attempt(1,%L,%L,%L,%L)',
    o,repeat('a',64),o::text,'tkn_test_different'), 'payment idempotency key conflict');

  if not has_function_privilege('service_role','public.claim_kafka_payment_attempt_processing(bigint,uuid)','execute')
    or has_function_privilege('anon','public.claim_kafka_payment_attempt_processing(bigint,uuid)','execute')
    or has_function_privilege('authenticated','public.claim_kafka_payment_attempt_processing(bigint,uuid)','execute')
    or exists(select 1 from pg_proc p, lateral aclexplode(p.proacl) acl
      where p.oid='public.claim_kafka_payment_attempt_processing(bigint,uuid)'::regprocedure
        and acl.grantee=0 and acl.privilege_type='EXECUTE')
    or not exists(select 1 from pg_proc where oid='public.claim_kafka_payment_attempt_processing(bigint,uuid)'::regprocedure
      and prosecdef and proconfig @> array['search_path=""']) then
    raise exception 'claim execution/security configuration unsafe';
  end if;
end;
$$;
