-- Disposable PostgreSQL ONLY. No application data, secrets or provider traffic.
insert into public.stores values (1,null),(2,null);
insert into vault.secrets(id) values ('11111111-1111-4111-8111-111111111111');
insert into public.store_payment_settings(store_id,active,culqi_enabled,culqi_public_key,culqi_private_key_secret_id)
values(1,true,true,'pk_test_localfixture','11111111-1111-4111-8111-111111111111');

create function public.session_claim_hash(o uuid) returns text language sql as $$
  select encode(extensions.digest(o::text,'sha256'),'hex');
$$;

create function public.make_session_claim_fixture(p_three_ds boolean default false)
returns jsonb language plpgsql as $$
declare o uuid := gen_random_uuid(); a uuid; r jsonb;
begin
  insert into public.orders(id,store_id,customer_name,customer_phone,customer_email,status,subtotal_amount_cents,total_amount_cents)
  values(o,1,'LOCAL SESSION CLAIM','000','test@example.com','pending_payment',1299,1299);
  insert into public.order_payment_sessions(store_id,order_id,token_hash,expires_at)
  values(1,o,public.session_claim_hash(o),clock_timestamp()+interval '15 minutes');
  r := public.validate_order_payment_session_and_reserve_attempt(1,o,public.session_claim_hash(o),o::text,'tkn_test_localfixture');
  a := (r->'payment_attempt'->>'id')::uuid;
  if p_three_ds then
    perform public.claim_kafka_payment_attempt_processing(1,a);
    perform public.mark_kafka_payment_attempt_requires_3ds(1,a,
      '8019959c-fab1-49eb-bbbe-b846d308d8df','chr_test_localfixture');
  end if;
  return jsonb_build_object('store',1,'order',o,'attempt',a,'key',o::text,'three_ds',p_three_ds);
end;
$$;

create function public.call_session_claim_fixture(f jsonb, patch jsonb default '{}'::jsonb)
returns jsonb language plpgsql as $$
declare x jsonb := f || patch;
begin
  if (x->>'three_ds')::boolean then
    return public.claim_payment_3ds_for_session((x->>'store')::bigint,(x->>'order')::uuid,(x->>'attempt')::uuid,
      coalesce(x->>'hash',public.session_claim_hash((x->>'order')::uuid)),coalesce(x->>'source','tkn_test_localfixture'),
      coalesce(x->>'device','8019959c-fab1-49eb-bbbe-b846d308d8df'));
  end if;
  return public.claim_payment_attempt_for_session((x->>'store')::bigint,(x->>'order')::uuid,(x->>'attempt')::uuid,
    coalesce(x->>'hash',public.session_claim_hash((x->>'order')::uuid)),x->>'key',coalesce(x->>'source','tkn_test_localfixture'));
end;
$$;

create function public.session_claim_state(p_order uuid)
returns text language sql as $$
  select md5(jsonb_build_array(
    (select to_jsonb(o) from public.orders o where id=p_order),
    (select jsonb_agg(a order by id) from public.payment_attempts a where order_id=p_order),
    (select jsonb_agg(s order by id) from public.order_payment_sessions s where order_id=p_order),
    (select jsonb_agg(e order by id) from public.payment_events e where order_id=p_order))::text);
$$;

do $$
declare f jsonb; r jsonb; before_state text; kind boolean; s text; patch jsonb; signature text;
begin
  foreach kind in array array[false,true] loop
    f := public.make_session_claim_fixture(kind);
    r := public.call_session_claim_fixture(f);
    if r->'authorized' is distinct from 'true'::jsonb or r->'acquired' is distinct from 'true'::jsonb then
      raise exception 'authorized claim did not acquire';
    end if;
    before_state := public.session_claim_state((f->>'order')::uuid);
    r := public.call_session_claim_fixture(f);
    if r->'acquired' is distinct from 'false'::jsonb or r->>'reason' <> 'already_processing'
      or public.session_claim_state((f->>'order')::uuid) <> before_state then
      raise exception 'duplicate claim changed state';
    end if;

    foreach s in array array['expired','revoked','used','past_expiration','revoked_at'] loop
      f := public.make_session_claim_fixture(kind);
      if s='past_expiration' then
        update public.order_payment_sessions set created_at=clock_timestamp()-interval '20 minutes',
          expires_at=clock_timestamp()-interval '1 second' where order_id=(f->>'order')::uuid;
      elsif s='revoked_at' then
        update public.order_payment_sessions set revoked_at=clock_timestamp() where order_id=(f->>'order')::uuid;
      else
        update public.order_payment_sessions set status=s where order_id=(f->>'order')::uuid;
      end if;
      before_state := public.session_claim_state((f->>'order')::uuid);
      r := public.call_session_claim_fixture(f);
      if r is distinct from '{"authorized":false,"acquired":false,"reason":"invalid_session"}'::jsonb
        or public.session_claim_state((f->>'order')::uuid) <> before_state then
        raise exception 'invalid session mutated data or leaked attempt';
      end if;
    end loop;

    f := public.make_session_claim_fixture(kind);
    foreach patch in array array[
      '{"hash":"bad"}'::jsonb,jsonb_build_object('hash',repeat('b',64)),
      '{"store":2}'::jsonb,jsonb_build_object('order',gen_random_uuid()),
      jsonb_build_object('attempt',gen_random_uuid())] loop
      before_state := public.session_claim_state((f->>'order')::uuid);
      r := public.call_session_claim_fixture(f,patch);
      if r->'authorized' is distinct from 'false'::jsonb or r ? 'payment_attempt'
        or public.session_claim_state((f->>'order')::uuid) <> before_state then
        raise exception 'identity authorization bypass';
      end if;
    end loop;

    f := public.make_session_claim_fixture(kind);
    update public.payment_attempts set reconciliation_required=true where id=(f->>'attempt')::uuid;
    before_state := public.session_claim_state((f->>'order')::uuid);
    r := public.call_session_claim_fixture(f);
    if r->'acquired' is distinct from 'false'::jsonb or r->>'reason' <> 'reconciliation_required'
      or public.session_claim_state((f->>'order')::uuid) <> before_state then
      raise exception 'reconciliation bypass';
    end if;

    foreach s in array array['paid','failed','expired','cancelled'] loop
      f := public.make_session_claim_fixture(kind);
      update public.payment_attempts set status=s::public.kafka_payment_attempt_status where id=(f->>'attempt')::uuid;
      if s='paid' then update public.orders set status='paid' where id=(f->>'order')::uuid; end if;
      before_state := public.session_claim_state((f->>'order')::uuid);
      r := public.call_session_claim_fixture(f);
      if r->'acquired' is distinct from 'false'::jsonb or r->>'reason'<>'terminal_state'
        or public.session_claim_state((f->>'order')::uuid) <> before_state then
        raise exception 'terminal claim mutated history';
      end if;
    end loop;

    -- Identity conflicts and financial inconsistencies must roll back without events.
    foreach s in array array['source','key','amount','order_total','environment','device','three_ds_flag','three_ds_state'] loop
      if s='key' and kind or s='device' and not kind then continue; end if;
      if s in ('three_ds_flag','three_ds_state') and not kind then continue; end if;
      f := public.make_session_claim_fixture(kind);
      patch := '{}'::jsonb;
      if s='source' then patch := '{"source":"tkn_test_other"}';
      elsif s='key' then patch := '{"key":"different"}';
      elsif s='device' then patch := '{"device":"8019959c-fab1-49eb-bbbe-b846d308d8de"}';
      elsif s='amount' then update public.payment_attempts set amount_cents=1300 where id=(f->>'attempt')::uuid;
      elsif s='environment' then
        delete from public.payment_events where payment_attempt_id=(f->>'attempt')::uuid;
        update public.payment_attempts set environment='live' where id=(f->>'attempt')::uuid;
      elsif s='order_total' then
        update public.orders set subtotal_amount_cents=1300,total_amount_cents=1300 where id=(f->>'order')::uuid;
      elsif s='three_ds_flag' then update public.payment_attempts set requires_3ds=false where id=(f->>'attempt')::uuid;
      elsif s='three_ds_state' then update public.payment_attempts set three_ds_status='failed' where id=(f->>'attempt')::uuid;
      end if;
      before_state := public.session_claim_state((f->>'order')::uuid);
      begin
        perform public.call_session_claim_fixture(f,patch);
        raise exception 'expected claim conflict';
      exception when raise_exception then
        if sqlerrm='expected claim conflict' then raise; end if;
        if sqlerrm not in ('payment idempotency key conflict','intento de pago inconsistente con la orden','intento 3DS invalido','transicion de intento de pago invalida') then raise; end if;
      end;
      if public.session_claim_state((f->>'order')::uuid) <> before_state then raise exception 'conflict changed rows'; end if;
    end loop;
  end loop;

  -- Expired sessions are recovery-only until revoked; revocation must revoke that access.
  f := public.make_session_claim_fixture();
  update public.order_payment_sessions set status='expired',created_at=clock_timestamp()-interval '20 minutes',
    expires_at=clock_timestamp()-interval '1 second' where order_id=(f->>'order')::uuid;
  if public.get_order_payment_status_for_session(1,(f->>'order')::uuid,public.session_claim_hash((f->>'order')::uuid))->'valid' is distinct from 'true'::jsonb then
    raise exception 'expired recovery fixture invalid';
  end if;
  r := public.revoke_order_payment_sessions(1,(f->>'order')::uuid);
  if r->>'revoked_count'<>'1'
    or public.get_order_payment_status_for_session(1,(f->>'order')::uuid,public.session_claim_hash((f->>'order')::uuid))->'valid' is distinct from 'false'::jsonb then
    raise exception 'expired recovery survived revocation';
  end if;

  foreach signature in array array[
    'public.claim_payment_attempt_for_session(bigint,uuid,uuid,text,text,text)',
    'public.claim_payment_3ds_for_session(bigint,uuid,uuid,text,text,text)',
    'public.revoke_order_payment_sessions(bigint,uuid)'] loop
    if not has_function_privilege('service_role',signature,'execute')
      or has_function_privilege('anon',signature,'execute') or has_function_privilege('authenticated',signature,'execute')
      or exists(select 1 from pg_proc p, lateral aclexplode(p.proacl) acl
        where p.oid=signature::regprocedure and acl.grantee=0 and acl.privilege_type='EXECUTE')
      or not exists(select 1 from pg_proc where oid=signature::regprocedure and prosecdef and proconfig @> array['search_path=""']) then
      raise exception 'service RPC ACL/config unsafe';
    end if;
  end loop;
  if has_function_privilege('service_role','public.kafka_claim_for_payment_session(bigint,uuid,uuid,text,text,text,boolean,text)','execute') then
    raise exception 'internal helper exposed';
  end if;
  if exists(select 1 from public.payment_events where sanitized_payload::text ~ '(tkn|sk|pk)_test_|[a-f0-9]{64}') then
    raise exception 'sensitive claim data in audit';
  end if;
end;
$$;
