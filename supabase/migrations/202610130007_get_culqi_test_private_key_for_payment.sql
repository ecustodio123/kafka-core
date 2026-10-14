-- Kafka Payments v1 Fase 3B: private Culqi TEST key lookup for payment Edge Function.
-- Review and apply manually after 202610130006_reserve_payment_attempts.sql.
-- This migration creates an RPC only; it does not modify orders, payments or settings.

create or replace function public.get_culqi_test_private_key_for_payment(
  p_store_id bigint
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  expected_secret_name text;
  private_key text;
begin
  if p_store_id is null or p_store_id <= 0 then
    raise exception 'configuracion de pagos invalida';
  end if;

  if not exists (
    select 1
    from public.stores
    where stores.id = p_store_id
  ) then
    raise exception 'configuracion de pagos invalida';
  end if;

  expected_secret_name := pg_catalog.format(
    'kafka-payments/store-%s/culqi-test-private-key',
    p_store_id
  );

  select decrypted.decrypted_secret
  into private_key
  from public.store_payment_settings as settings
  join vault.decrypted_secrets as decrypted
    on decrypted.id = settings.culqi_private_key_secret_id
    and decrypted.name = expected_secret_name
  where settings.store_id = p_store_id
    and settings.provider = 'culqi'
    and settings.environment = 'test'
    and settings.active = true
    and settings.culqi_enabled = true
    and settings.currency = 'PEN'
    and settings.culqi_public_key ~ '^pk_test_[A-Za-z0-9]+$'
    and settings.culqi_private_key_secret_id is not null;

  if private_key is null or private_key !~ '^sk_test_[A-Za-z0-9]+$' then
    raise exception 'configuracion de pagos invalida';
  end if;

  return private_key;
end;
$$;

revoke all on function public.get_culqi_test_private_key_for_payment(bigint)
from public, anon, authenticated;

grant execute on function public.get_culqi_test_private_key_for_payment(bigint)
to service_role;

-- This RPC is intentionally executable only by service_role.
-- The caller must never log the returned private key.
