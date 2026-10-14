-- Kafka Payments v1 Fase 3A: fix ambiguous column references in Culqi settings RPC.
-- Review and apply manually after 202610130004_store_culqi_test_settings.sql.

create or replace function public.upsert_store_culqi_test_settings(
  requested_store_id bigint,
  culqi_public_key text,
  culqi_private_key text,
  culqi_webhook_secret text default null,
  enable_payments boolean default true
)
returns table (
  store_id bigint,
  provider text,
  environment text,
  active boolean,
  culqi_enabled boolean,
  currency char(3),
  has_culqi_private_key boolean,
  has_culqi_webhook_secret boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized_public_key text;
  normalized_private_key text;
  normalized_webhook_secret text;
  private_secret_name text;
  webhook_secret_name text;
  private_secret_id uuid;
  webhook_secret_id uuid;
begin
  if requested_store_id is null or requested_store_id <= 0 then
    raise exception 'tienda invalida';
  end if;

  if auth.uid() is null then
    raise exception 'usuario no autenticado';
  end if;

  if not exists (
    select 1
    from public.stores
    where stores.id = requested_store_id
      and stores.owner_user_id = auth.uid()
  ) then
    raise exception 'tienda no autorizada';
  end if;

  normalized_public_key := btrim(coalesce(culqi_public_key, ''));
  normalized_private_key := btrim(coalesce(culqi_private_key, ''));
  normalized_webhook_secret := nullif(btrim(coalesce(culqi_webhook_secret, '')), '');

  if normalized_public_key !~ '^pk_test_[A-Za-z0-9]+$' then
    raise exception 'llave publica Culqi TEST invalida';
  end if;

  if normalized_private_key !~ '^sk_test_[A-Za-z0-9]+$' then
    raise exception 'llave privada Culqi TEST invalida';
  end if;

  if normalized_webhook_secret is not null and length(normalized_webhook_secret) < 12 then
    raise exception 'webhook secret Culqi TEST invalido';
  end if;

  private_secret_name := format(
    'kafka-payments/store-%s/culqi-test-private-key',
    requested_store_id
  );
  webhook_secret_name := format(
    'kafka-payments/store-%s/culqi-test-webhook-secret',
    requested_store_id
  );

  select secrets.id
  into private_secret_id
  from vault.secrets
  where secrets.name = private_secret_name;

  if private_secret_id is null then
    private_secret_id := vault.create_secret(
      normalized_private_key,
      private_secret_name,
      format('Kafka Payments Culqi TEST private key for store %s', requested_store_id)
    );
  else
    perform vault.update_secret(
      private_secret_id,
      normalized_private_key,
      private_secret_name,
      format('Kafka Payments Culqi TEST private key for store %s', requested_store_id)
    );
  end if;

  if normalized_webhook_secret is not null then
    select secrets.id
    into webhook_secret_id
    from vault.secrets
    where secrets.name = webhook_secret_name;

    if webhook_secret_id is null then
      webhook_secret_id := vault.create_secret(
        normalized_webhook_secret,
        webhook_secret_name,
        format('Kafka Payments Culqi TEST webhook secret for store %s', requested_store_id)
      );
    else
      perform vault.update_secret(
        webhook_secret_id,
        normalized_webhook_secret,
        webhook_secret_name,
        format('Kafka Payments Culqi TEST webhook secret for store %s', requested_store_id)
      );
    end if;
  end if;

  insert into public.store_payment_settings (
    store_id,
    provider,
    environment,
    active,
    culqi_public_key,
    culqi_private_key_secret_id,
    culqi_webhook_secret_id,
    culqi_enabled,
    currency,
    updated_at
  )
  values (
    requested_store_id,
    'culqi',
    'test',
    true,
    normalized_public_key,
    private_secret_id,
    webhook_secret_id,
    enable_payments,
    'PEN',
    now()
  )
  on conflict on constraint store_payment_settings_store_environment_unique
  do update set
    active = excluded.active,
    culqi_public_key = excluded.culqi_public_key,
    culqi_private_key_secret_id = excluded.culqi_private_key_secret_id,
    culqi_webhook_secret_id = coalesce(
      excluded.culqi_webhook_secret_id,
      public.store_payment_settings.culqi_webhook_secret_id
    ),
    culqi_enabled = excluded.culqi_enabled,
    currency = excluded.currency,
    updated_at = now();

  return query
  select
    settings.store_id,
    settings.provider,
    settings.environment,
    settings.active,
    settings.culqi_enabled,
    settings.currency,
    settings.culqi_private_key_secret_id is not null as has_culqi_private_key,
    settings.culqi_webhook_secret_id is not null as has_culqi_webhook_secret
  from public.store_payment_settings as settings
  where settings.store_id = requested_store_id
    and settings.provider = 'culqi'
    and settings.environment = 'test';
end;
$$;

revoke all on function public.upsert_store_culqi_test_settings(
  bigint,
  text,
  text,
  text,
  boolean
) from public, anon, authenticated;

grant execute on function public.upsert_store_culqi_test_settings(
  bigint,
  text,
  text,
  text,
  boolean
) to authenticated;
