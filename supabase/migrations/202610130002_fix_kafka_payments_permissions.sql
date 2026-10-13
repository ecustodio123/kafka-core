-- Kafka Payments v1 permission correction.
-- This records the permissions already applied manually in Supabase.
-- It does not modify tables, columns, RLS policies, or functions.

revoke all on public.store_payment_settings from public, anon, authenticated;

revoke all on public.orders from public, anon, authenticated;
revoke all on public.order_items from public, anon, authenticated;
revoke all on public.payment_attempts from public, anon, authenticated;
revoke all on public.payment_events from public, anon, authenticated;

grant select on public.orders to authenticated;
grant select on public.order_items to authenticated;
grant select on public.payment_attempts to authenticated;
grant select on public.payment_events to authenticated;
