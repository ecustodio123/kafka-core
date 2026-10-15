-- Kafka Payments: persist uncertain results and synchronize terminal metadata.
-- Review and apply manually after 012. Applying this file changes no existing
-- records; historical terminal metadata needs a separate evidence-based review.

-- Private response helper shared by every terminal/replay path. Diagnostic
-- metadata is additive to the existing 006 response contract, never auth proof.
create or replace function public.kafka_payment_attempt_reconciliation_response(
  p_payment_attempt_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select public.kafka_payment_attempt_response(attempts.id)
    || jsonb_build_object('requires_3ds', attempts.requires_3ds,
      'three_ds_status', attempts.three_ds_status,
      'three_ds_completed_at', attempts.three_ds_completed_at,
      'reconciliation_required', attempts.reconciliation_required)
  from public.payment_attempts as attempts
  where attempts.id = p_payment_attempt_id;
$$;

revoke all on function public.kafka_payment_attempt_reconciliation_response(uuid)
from public, anon, authenticated;
grant execute on function public.kafka_payment_attempt_reconciliation_response(uuid)
to service_role;

create or replace function public.record_kafka_payment_attempt_uncertainty(
  p_store_id bigint,
  p_payment_attempt_id uuid,
  p_reason text,
  p_provider_reference text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  attempt_order_id uuid;
  locked_order public.orders%rowtype;
  locked_attempt public.payment_attempts%rowtype;
  normalized_reason text;
  normalized_reference text;
begin
  normalized_reason := btrim(coalesce(p_reason, ''));
  normalized_reference := nullif(btrim(coalesce(p_provider_reference, '')), '');
  if p_store_id is null or p_store_id <= 0 or p_payment_attempt_id is null
    or length(normalized_reason) > 100
    or (
      normalized_reason <> 'mock_uncertain_response'
      and normalized_reason !~ '^culqi_(3ds_)?(timeout|network_error|success_without_charge_id|ambiguous_[0-9]{3}|http_[0-9]{3}|finalize_failed|metadata_failed)$'
    )
    or (normalized_reference is not null and (
      length(normalized_reference) > 160
      or normalized_reference !~ '^chr_test_[A-Za-z0-9]+$'
    ))
  then
    raise exception 'registro de incertidumbre invalido';
  end if;

  select attempts.order_id into attempt_order_id
  from public.payment_attempts as attempts
  where attempts.store_id = p_store_id and attempts.id = p_payment_attempt_id;
  if not found then
    raise exception 'registro de incertidumbre invalido';
  end if;

  select * into locked_order from public.orders
  where orders.store_id = p_store_id and orders.id = attempt_order_id
  for update;
  if not found then
    raise exception 'registro de incertidumbre invalido';
  end if;

  select * into locked_attempt from public.payment_attempts
  where payment_attempts.store_id = p_store_id
    and payment_attempts.id = p_payment_attempt_id
    and payment_attempts.order_id = locked_order.id
  for update;
  if not found or locked_attempt.provider <> 'culqi'
    or locked_attempt.environment <> 'test'
    or locked_attempt.currency <> 'PEN'
    or locked_attempt.currency <> locked_order.currency
    or locked_attempt.amount_cents <> locked_order.total_amount_cents
  then
    raise exception 'registro de incertidumbre invalido';
  end if;

  -- A late timeout must not reopen an attempt finalized concurrently.
  if (locked_attempt.status = 'paid' and locked_order.status = 'paid')
    or (locked_attempt.status = 'failed' and locked_order.status in ('payment_failed', 'pending_payment', 'paid'))
  then
    return public.kafka_payment_attempt_reconciliation_response(locked_attempt.id);
  end if;
  if locked_attempt.status <> 'processing' or locked_order.status <> 'pending_payment' then
    raise exception 'registro de incertidumbre invalido';
  end if;
  if normalized_reference is not null and locked_attempt.provider_reference is not null
    and locked_attempt.provider_reference <> normalized_reference
  then
    raise exception 'registro de incertidumbre invalido';
  end if;

  if locked_attempt.reconciliation_required is distinct from true
    or locked_attempt.reconciliation_reason is distinct from normalized_reason
    or (normalized_reference is not null and locked_attempt.provider_reference is null)
  then
    update public.payment_attempts
    set reconciliation_required = true,
        reconciliation_reason = normalized_reason,
        provider_reference = coalesce(normalized_reference, provider_reference),
        updated_at = now()
    where payment_attempts.id = locked_attempt.id
    returning * into locked_attempt;

    insert into public.payment_events (
      payment_attempt_id, order_id, store_id, provider, environment,
      event_type, status_before, status_after, sanitized_payload
    ) values (
      locked_attempt.id, locked_attempt.order_id, locked_attempt.store_id,
      locked_attempt.provider, locked_attempt.environment, 'error',
      'processing', 'processing', jsonb_build_object(
        'action', 'record_payment_uncertainty', 'reason', normalized_reason)
    );
  end if;

  return public.kafka_payment_attempt_reconciliation_response(locked_attempt.id);
end;
$$;

revoke all on function public.record_kafka_payment_attempt_uncertainty(bigint, uuid, text, text)
from public, anon, authenticated;
grant execute on function public.record_kafka_payment_attempt_uncertainty(bigint, uuid, text, text)
to service_role;


create or replace function public.finalize_kafka_payment_attempt(
  p_store_id bigint,
  p_payment_attempt_id uuid,
  p_final_status public.kafka_payment_attempt_status,
  p_culqi_charge_id text default null,
  p_failure_code text default null,
  p_failure_message text default null,
  p_provider_event_id text default null,
  p_provider_reference text default null,
  p_sanitized_payload jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  attempt_order_id uuid;
  duplicate_event_attempt_id uuid;
  locked_order public.orders%rowtype;
  locked_attempt public.payment_attempts%rowtype;
  status_before text;
  normalized_charge_id text;
  normalized_failure_code text;
  normalized_failure_message text;
  normalized_provider_event_id text;
  normalized_provider_reference text;
  preserve_reconciliation boolean;
  audit_before jsonb;
begin
  if p_store_id is null or p_store_id <= 0 then
    raise exception 'tienda invalida';
  end if;

  if p_payment_attempt_id is null then
    raise exception 'intento de pago invalido';
  end if;

  if p_final_status is null or p_final_status not in ('paid', 'failed') then
    raise exception 'estado final invalido';
  end if;

  normalized_charge_id := nullif(btrim(coalesce(p_culqi_charge_id, '')), '');
  normalized_failure_code := nullif(btrim(coalesce(p_failure_code, '')), '');
  normalized_failure_message := nullif(btrim(coalesce(p_failure_message, '')), '');
  normalized_provider_event_id := nullif(btrim(coalesce(p_provider_event_id, '')), '');
  normalized_provider_reference := nullif(btrim(coalesce(p_provider_reference, '')), '');

  if normalized_charge_id is not null and length(normalized_charge_id) > 160 then
    raise exception 'culqi_charge_id invalido';
  end if;

  if normalized_failure_code is not null and length(normalized_failure_code) > 120 then
    raise exception 'failure_code invalido';
  end if;

  if normalized_failure_message is not null and length(normalized_failure_message) > 500 then
    raise exception 'failure_message invalido';
  end if;

  if normalized_provider_event_id is not null and length(normalized_provider_event_id) > 180 then
    raise exception 'provider_event_id invalido';
  end if;

  if normalized_provider_reference is not null and length(normalized_provider_reference) > 180 then
    raise exception 'provider_reference invalido';
  end if;

  if p_sanitized_payload is not null
    and (
      jsonb_typeof(p_sanitized_payload) <> 'object'
      or pg_catalog.length(p_sanitized_payload::text) > 20000
      or p_sanitized_payload::text ~ '(tkn|ype|crd|sk|pk)_test_'
      or p_sanitized_payload::text ~ '(tkn|ype|crd|sk|pk)_live_'
    )
  then
    raise exception 'payload sanitizado invalido';
  end if;

  if p_final_status = 'paid' and normalized_charge_id is null then
    raise exception 'culqi_charge_id requerido para pago aprobado';
  end if;

  select payment_attempts.order_id
  into attempt_order_id
  from public.payment_attempts
  where payment_attempts.store_id = p_store_id
    and payment_attempts.id = p_payment_attempt_id;

  if not found then
    raise exception 'intento de pago invalido';
  end if;

  select *
  into locked_order
  from public.orders
  where orders.store_id = p_store_id
    and orders.id = attempt_order_id
  for update;

  if not found then
    raise exception 'orden invalida';
  end if;

  select *
  into locked_attempt
  from public.payment_attempts
  where payment_attempts.store_id = p_store_id
    and payment_attempts.id = p_payment_attempt_id
  for update;

  if not found then
    raise exception 'intento de pago invalido';
  end if;

  if locked_attempt.environment <> 'test'
    or locked_attempt.provider <> 'culqi'
    or locked_attempt.order_id <> locked_order.id
    or locked_attempt.amount_cents <> locked_order.total_amount_cents
    or locked_attempt.currency <> locked_order.currency
  then
    raise exception 'intento de pago inconsistente con la orden';
  end if;

  if locked_attempt.status = 'paid' and locked_order.status <> 'paid' then
    raise exception 'finalizacion de pago en conflicto';
  end if;

  -- Serialize on orders -> attempts before interpreting duplicate events.
  -- A repeated event ID cannot hide a changed result or charge reference.
  if normalized_provider_event_id is not null then
    select payment_events.payment_attempt_id
    into duplicate_event_attempt_id
    from public.payment_events
    where payment_events.store_id = p_store_id
      and payment_events.environment = 'test'
      and payment_events.provider = 'culqi'
      and payment_events.provider_event_id = normalized_provider_event_id;
    if found then
      if duplicate_event_attempt_id <> p_payment_attempt_id then
        raise exception 'provider_event_id ya registrado para otro intento';
      end if;
      if locked_attempt.status is distinct from p_final_status
        or (p_final_status = 'paid' and locked_attempt.culqi_charge_id is distinct from normalized_charge_id)
      then
        raise exception 'finalizacion de pago en conflicto';
      end if;
      return public.kafka_payment_attempt_reconciliation_response(locked_attempt.id);
    end if;
  end if;

  if locked_attempt.status = 'paid' and (
    locked_order.status <> 'paid'
    or (p_final_status = 'paid' and locked_attempt.culqi_charge_id is distinct from normalized_charge_id)
  ) then
    raise exception 'finalizacion de pago en conflicto';
  end if;

  if locked_attempt.status = 'failed' then
    if p_final_status = 'failed' then
      return public.kafka_payment_attempt_reconciliation_response(locked_attempt.id);
    end if;

    raise exception 'intento de pago ya finalizado';
  end if;

  if locked_order.status = 'paid' or locked_attempt.status = 'paid' then
    return public.kafka_payment_attempt_reconciliation_response(locked_attempt.id);
  end if;

  if locked_attempt.status <> 'processing' then
    raise exception 'transicion de intento de pago invalida';
  end if;

  if locked_order.status <> 'pending_payment' then
    raise exception 'estado de orden invalido para finalizar pago';
  end if;

  status_before := locked_attempt.status::text;

  audit_before := jsonb_build_object(
    'three_ds_status', locked_attempt.three_ds_status,
    'three_ds_completed_at', locked_attempt.three_ds_completed_at,
    'reconciliation_required', locked_attempt.reconciliation_required,
    'provider_reference', case
      when locked_attempt.provider_reference ~ '^chr_test_[A-Za-z0-9]{1,151}$'
      then locked_attempt.provider_reference else null end
  );

  -- Sanitized JSON is diagnostic caller input. Neither HTTP status nor a
  -- caller's boolean establishes an authentication outcome. Preserve 3DS
  -- observations/timestamps; only a future verified-auth workflow may change them.
  -- Financial timeouts can be resolved by terminal charge evidence, but unrelated
  -- review reasons and unverified 3DS must not be silently cleared.
  preserve_reconciliation := locked_attempt.requires_3ds
    or locked_attempt.three_ds_status is not null
    or locked_attempt.three_ds_completed_at is not null
    or locked_attempt.three_ds_claimed_at is not null
    or locked_attempt.three_ds_device_fingerprint_hash is not null
    or (locked_attempt.reconciliation_required and (
      locked_attempt.reconciliation_reason is null
      or locked_attempt.reconciliation_reason !~ '^(mock_uncertain_response|culqi_(timeout|network_error|success_without_charge_id|ambiguous_[0-9]{3}|http_[0-9]{3}|finalize_failed))$'
    ));

  if p_final_status = 'paid' then
    update public.payment_attempts
    set status = 'paid',
        culqi_charge_id = normalized_charge_id,
        provider_reference = coalesce(normalized_provider_reference, normalized_charge_id),
        failure_code = null,
        failure_message = null,
        updated_at = now()
    where payment_attempts.id = locked_attempt.id
    returning *
    into locked_attempt;

    update public.orders
    set status = 'paid',
        paid_at = coalesce(paid_at, now()),
        updated_at = now()
    where orders.store_id = locked_order.store_id
      and orders.id = locked_order.id;
  else
    update public.payment_attempts
    set status = 'failed',
        failure_code = normalized_failure_code,
        failure_message = normalized_failure_message,
        provider_reference = coalesce(normalized_provider_reference, provider_reference),
        updated_at = now()
    where payment_attempts.id = locked_attempt.id
    returning *
    into locked_attempt;

    update public.orders
    set status = 'payment_failed',
        updated_at = now()
    where orders.store_id = locked_order.store_id
      and orders.id = locked_order.id
      and orders.status <> 'paid';
  end if;

  update public.payment_attempts
  set reconciliation_required = preserve_reconciliation,
      reconciliation_reason = case
        when preserve_reconciliation then coalesce(reconciliation_reason, '3ds_authentication_unverified')
        else null end
  where payment_attempts.id = locked_attempt.id
  returning * into locked_attempt;

  insert into public.payment_events (
    payment_attempt_id,
    order_id,
    store_id,
    provider,
    environment,
    event_type,
    provider_event_id,
    provider_reference,
    status_before,
    status_after,
    sanitized_payload
  )
  values (
    locked_attempt.id,
    locked_attempt.order_id,
    locked_attempt.store_id,
    locked_attempt.provider,
    locked_attempt.environment,
    'status_changed',
    normalized_provider_event_id,
    coalesce(normalized_provider_reference, normalized_charge_id),
    status_before,
    locked_attempt.status::text,
    (coalesce(p_sanitized_payload, '{}'::jsonb)
      - 'three_ds_authenticated' - 'three_ds_completed')
      || jsonb_build_object('finalization_audit', jsonb_build_object(
        'before', audit_before,
        'three_ds_outcome_verified_by_finalization', false,
        'reconciliation_required_after', locked_attempt.reconciliation_required))
  );

  return public.kafka_payment_attempt_reconciliation_response(locked_attempt.id);
exception
  when unique_violation then
    if normalized_provider_event_id is not null then
      select payment_events.payment_attempt_id
      into duplicate_event_attempt_id
      from public.payment_events
      where payment_events.store_id = p_store_id
        and payment_events.environment = 'test'
        and payment_events.provider = 'culqi'
        and payment_events.provider_event_id = normalized_provider_event_id
      limit 1;

      if found and duplicate_event_attempt_id = p_payment_attempt_id then
        select * into locked_attempt from public.payment_attempts
        where payment_attempts.id = p_payment_attempt_id and payment_attempts.store_id = p_store_id;
        if locked_attempt.status is distinct from p_final_status
          or (p_final_status = 'paid' and locked_attempt.culqi_charge_id is distinct from normalized_charge_id)
        then
          raise exception 'finalizacion de pago en conflicto';
        end if;
        return public.kafka_payment_attempt_reconciliation_response(duplicate_event_attempt_id);
      end if;
    end if;

    raise;
end;
$$;


revoke all on function public.finalize_kafka_payment_attempt(
  bigint, uuid, public.kafka_payment_attempt_status, text, text, text, text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.finalize_kafka_payment_attempt(
  bigint, uuid, public.kafka_payment_attempt_status, text, text, text, text, text, jsonb
) to service_role;
