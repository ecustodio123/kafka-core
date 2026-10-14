-- LOCAL ONLY: fixture for a disposable empty PostgreSQL database.
-- Not a migration; do not run against Supabase or an existing application DB.
\set ON_ERROR_STOP on
create schema extensions;
create extension pgcrypto with schema extensions;
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role;
  end if;
end;
$$;

-- Minimal column-compatible fixture for migrations 001, 006 and 011.
create table public.stores (id bigint primary key);
create table public.orders (
  id uuid primary key, store_id bigint, status text,
  total_amount_cents integer, currency char(3)
);
create table public.payment_attempts (
  id uuid primary key, order_id uuid, store_id bigint,
  provider text, environment text, status text, requires_3ds boolean,
  three_ds_status text, amount_cents integer, currency char(3),
  idempotency_fingerprint text
);
insert into public.stores values (1), (2);
insert into public.orders values
  ('11111111-1111-4111-8111-111111111111', 1, 'pending_payment', 1299, 'PEN');
insert into public.payment_attempts values (
  '22222222-2222-4222-8222-222222222222',
  '11111111-1111-4111-8111-111111111111',
  1, 'culqi', 'test', 'processing', true, 'required', 1299, 'PEN',
  encode(extensions.digest(jsonb_build_object(
    'store_id', 1::bigint,
    'order_id', '11111111-1111-4111-8111-111111111111'::uuid,
    'environment', 'test', 'amount_cents', 1299, 'currency', 'PEN'::char(3),
    'culqi_source_id_sha256', encode(extensions.digest('tkn_test_fixture', 'sha256'), 'hex')
  )::text, 'sha256'), 'hex')
);

\ir ../migrations/202610130012_validate_payment_attempt_source.sql

create function public.expect_source_rejected(p_store bigint, p_attempt uuid, p_source text)
returns void language plpgsql as $$
begin
  begin
    perform public.validate_payment_attempt_source(p_store, p_attempt, p_source);
  exception when raise_exception then
    if sqlerrm <> 'validacion de intento de pago invalida' then
      raise exception 'unexpected validation error';
    end if;
    return;
  end;
  raise exception 'expected validation to fail';
end;
$$;

do $$
declare
  original_attempt public.payment_attempts%rowtype;
  test_status text;
begin
  select * into original_attempt from public.payment_attempts;
  if public.validate_payment_attempt_source(1, original_attempt.id, '  tkn_test_fixture  ') is distinct from true then
    raise exception 'valid source rejected';
  end if;
  perform public.expect_source_rejected(1, original_attempt.id, 'tkn_test_wrong');
  perform public.expect_source_rejected(2, original_attempt.id, 'tkn_test_fixture');
  perform public.expect_source_rejected(1, gen_random_uuid(), 'tkn_test_fixture');
  perform public.expect_source_rejected(null, original_attempt.id, 'tkn_test_fixture');
  perform public.expect_source_rejected(1, original_attempt.id, null);

  foreach test_status in array array['created', 'paid', 'failed', 'expired', 'cancelled'] loop
    update public.payment_attempts set status = test_status;
    perform public.expect_source_rejected(1, original_attempt.id, 'tkn_test_fixture');
  end loop;
  update public.payment_attempts set status = 'processing', environment = 'live';
  perform public.expect_source_rejected(1, original_attempt.id, 'tkn_test_fixture');
  update public.payment_attempts set environment = 'test', provider = 'other';
  perform public.expect_source_rejected(1, original_attempt.id, 'tkn_test_fixture');
  update public.payment_attempts set provider = 'culqi', requires_3ds = false;
  perform public.expect_source_rejected(1, original_attempt.id, 'tkn_test_fixture');
  update public.payment_attempts set requires_3ds = true, amount_cents = 1300;
  perform public.expect_source_rejected(1, original_attempt.id, 'tkn_test_fixture');
  update public.payment_attempts set amount_cents = 1299, idempotency_fingerprint = null;
  perform public.expect_source_rejected(1, original_attempt.id, 'tkn_test_fixture');
  update public.payment_attempts set idempotency_fingerprint = original_attempt.idempotency_fingerprint;
  update public.orders set status = 'paid';
  perform public.expect_source_rejected(1, original_attempt.id, 'tkn_test_fixture');
  update public.orders set status = 'pending_payment', store_id = 2;
  perform public.expect_source_rejected(1, original_attempt.id, 'tkn_test_fixture');
  update public.orders set store_id = 1;

  update public.payment_attempts set three_ds_status = 'completion_processing';
  if public.validate_payment_attempt_source(1, original_attempt.id, 'tkn_test_fixture') is distinct from true then
    raise exception 'claimed duplicate source rejected';
  end if;
  update public.payment_attempts set three_ds_status = 'required';

  if (select count(*) from public.payment_attempts) <> 1
    or (select to_jsonb(a) from public.payment_attempts as a) <> to_jsonb(original_attempt)
  then
    raise exception 'validation changed the original attempt';
  end if;

  if has_function_privilege('anon', 'public.validate_payment_attempt_source(bigint,uuid,text)', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.validate_payment_attempt_source(bigint,uuid,text)', 'EXECUTE')
    or not has_function_privilege('service_role', 'public.validate_payment_attempt_source(bigint,uuid,text)', 'EXECUTE')
  then
    raise exception 'invalid execute privileges';
  end if;
end;
$$;

-- A read-only transaction also catches accidental writes inside the function.
begin read only;
set local role service_role;
select public.validate_payment_attempt_source(
  1, '22222222-2222-4222-8222-222222222222', 'tkn_test_fixture'
);
commit;
