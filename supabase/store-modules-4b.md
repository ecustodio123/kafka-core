# Step 4B: two global roles and store modules

Prepared locally. Nothing in this document or its migration has been applied remotely.
Migration: `migrations/202610200001_store_modules_security.sql`.
Run it manually only after reviewing the prerequisites below. It adopts existing
`public.store_features`, `public.services`, `public.staff`; it does not create them.

## Authorization contract

- Exactly two application roles: `super_admin` and `admin`, in
  `auth.users.raw_app_meta_data.global_role`. No new PostgreSQL roles, plans,
  membership hierarchy or client-accessible role setter.
- A missing global_role KEY is temporarily interpreted as `admin` ONLY if that Auth
  user already owns a store. Missing role without ownership grants no management.
  Explicit null, empty/unknown roles and malformed app metadata fail closed.
  `raw_user_meta_data` is never used for authorization. No existing users are backfilled.
- SECURITY DEFINER helpers in `kafka_modules` read the live trusted role and store
  configuration. No client gets direct Auth metadata permissions. Only the migration's
  trusted owner creates helper functions, with empty search_path and qualified objects.
- Super Admin reads/creates/edits stores, assigns their owner and manages store flags.
  Store deletion is NOT added: financial/history retention and cascades are outside scope.
  Super Admin can maintain Services/Staff even if disabled or missing configuration.
- Admin reads its own flags regardless of which modules are enabled. Services/Staff
  management requires CURRENT ownership and the corresponding flag IS TRUE.
  Missing configuration/NULL flag denies management. `is_active=false` drafts remain
  visible to an authorized manager. No user can retarget content by updating store_id/id.
- `anon` reads only active Services/Staff with their respective module enabled.
  No public writes, configuration reads or store reads are introduced. Authenticated
  clients use management policies, not an all-tenants public SELECT fallback.
  Active published content is public by definition, not confidential tenant data.
- Confirmed Services/Staff defaults are `is_active=true`, `sort_order=0`, UUID primary
  key and bigint store_id. A new row that omits is_active is immediately public IF
  its module is enabled. Future CRUD screens must explicitly send false for drafts;
  this migration does not change defaults or deactivate existing content.
- No client DELETE on store_features, TRUNCATE, or schema CREATE is added.
  Feature updates are limited to the three boolean fields; content updates exclude
  identity, store_id and system timestamps.

Role/flag changes apply to a subsequent statement without waiting for JWT refresh.
This is PostgreSQL statement-snapshot authorization, not cancellation of an operation
already authorized/in flight. Disabling a module neither deletes rows nor removes
previously downloaded content or public Storage assets.

## Deliberate scope limits / compatibility

Existing store owner SELECT policy is retained. The only store policies added grant
Super Admin SELECT/INSERT/UPDATE; no stores, owners or flags are seeded or updated.
There is no Veterinaria Cueva identifier, exception, migration or data change.

Products/categories policies, grants, Commerce view, product creation RPC, Storage
policies, frontend and Payments are unchanged. In particular:

- `commerce_enabled` can be stored/edited but is NOT enforced on existing catalog
  tables, RPCs, public storefront reads, Storage or payment endpoints in step 4B.
  The module helpers deliberately accept only services/staff; `commerce` is denied,
  not silently advertised as protected. A later approved catalog review is required.
- A Super Admin does NOT automatically gain cross-tenant catalog/payment access.
  Existing product creation remains owner-only. Do not widen those RPCs here.
- Revoking global_role does NOT revoke legacy owner access to the old catalog;
  those policies intentionally remain unchanged. Do not treat this as universal
  account disablement. Ownership/Auth revocation and catalog authorization need
  their existing trusted procedures and a separately reviewed rollout.
- The frontend still expects one store per owner (maybeSingle), has no role-aware
  selector or modules navigation, and needs step 4C. Database support for multiple
  owned stores does not fix that frontend assumption.
- Image URLs, content validation, duplicate submission recovery, system timestamp
  defaults/triggers and Storage upload policies need review before new CRUD screens.
  These RLS policies do not validate arbitrary image URL content or server-side files.

## Prerequisites: manual READ-ONLY checks

Execute these SELECTs yourself in the existing project's trusted SQL Editor.
Do not export credentials, full Auth records, raw metadata or customer data.

```sql
select table_schema, table_name, column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema='public' and table_name in ('stores','store_features','services','staff')
order by table_name, ordinal_position;

select conrelid::regclass as relation, conname, convalidated, pg_get_constraintdef(oid)
from pg_constraint
where conrelid in ('public.stores'::regclass,'public.store_features'::regclass,
  'public.services'::regclass,'public.staff'::regclass);

select schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
from pg_policies where schemaname='public'
  and tablename in ('stores','store_features','services','staff');

select raw_app_meta_data->>'global_role' as explicit_role, count(*)
from auth.users group by raw_app_meta_data->>'global_role';

select f.store_id, f.services_enabled, f.staff_enabled, f.commerce_enabled,
  (select count(*) from public.services s where s.store_id=f.store_id and s.is_active is true) as active_services,
  (select count(*) from public.staff s where s.store_id=f.store_id and s.is_active is true) as active_staff
from public.store_features f order by f.store_id;
```

The role query does not distinguish missing/explicit-null keys; the migration does.
Review aggregate counts and publication flags before granting public SELECT: existing
active rows in enabled modules will become publicly readable. Do not change Cueva
rows/configuration as part of this application.

The migration requires bigint store IDs, UUID content IDs, boolean flags/is_active,
integer sort_order, text/varchar content fields, the declared PKs and validated
store foreign keys. It checks required columns and aborts if they differ. It does
not infer or rewrite timestamps, defaults, indexes or other application constraints.

It also refuses unexpected policies on the three new tables, existing store write
policies, unreviewed client column grants, unsafe Auth write grants or disabled store
RLS. An existing kafka_modules schema must be owned by the applying role. No unknown
policy is silently dropped. If any check fails, STOP and review the actual DDL/ACLs;
do not remove the guard or rerun old catalog scripts to force it through.

In Dashboard API settings confirm `kafka_modules` is NOT an exposed schema.
Never add it to expose the helpers as frontend RPCs. Helper privileges exist only
so RLS can invoke them internally. The role reader returns only the caller's role;
the public helper returns only publication eligibility, not private configuration.

## Manual application (not performed by the agent)

1. Confirm the project, prior catalog migrations and the three existing tables.
   Review the read-only checks, new public visibility, role transition and SQL diff.
   Keep a local, ignored backup of current policies/grants before production changes.
2. In SQL Editor use the trusted `postgres` context. It must read Auth and own/bypass
   RLS on stores/store_features; the migration checks this to prevent recursive helpers.
   No Auth grants to anon/authenticated are needed or allowed.
3. Paste the COMPLETE migration, including BEGIN/COMMIT, and run manually once.
   All changes are transactional. Failure rolls back this migration; investigate
   the reported prerequisite instead of applying fragments. Reapplication is tested.
4. Assign the initial Super Admin only after verifying an EXISTING Auth account's UUID
   and email in Authentication > Users. The migration does NOT pick an account or
   automatically promote the first owner.
5. Verify policies, grants, helper ownership/config and all three new table RLS flags
   with read-only catalog queries. Test allow/deny with dedicated users/data only
   after separate authorization; SQL Editor's privileged session is not a client test.
   Do not modify live store content as an implicit smoke test.

### Trusted bootstrap example (manual only)

No password, JWT or service key is pasted into SQL. Replace BOTH placeholders with
the verified Auth account. The all-zero UUID intentionally fails if left unchanged.
This assigns only the application role, never PostgreSQL superuser privileges.

```sql
begin;
do $$
declare
  target_id uuid := '00000000-0000-0000-0000-000000000000';
  expected_email text := 'REPLACE_WITH_VERIFIED_EMAIL';
  previous jsonb;
begin
  if target_id='00000000-0000-0000-0000-000000000000'::uuid
    or expected_email='REPLACE_WITH_VERIFIED_EMAIL' then
    raise exception 'Verify target UUID and email first';
  end if;
  select u.raw_app_meta_data into previous from auth.users u
  where u.id=target_id and u.email=expected_email for update;
  if not found or (previous is not null and jsonb_typeof(previous)<>'object') then
    raise exception 'Verified Auth account not found or metadata requires review';
  end if;
  update auth.users set raw_app_meta_data=coalesce(previous,'{}'::jsonb)
    || jsonb_build_object('global_role','super_admin') where id=target_id;
end $$;
commit;
```

This merges metadata instead of replacing unrelated provider fields. Future explicit
Admin assignments use the same trusted procedure with `admin`, scoped to a verified
account; missing-key owners already work during transition. Never expose role changes
through a client-writable profile or ordinary authenticated RPC. Sign in again/refresh
the session for future role-aware UI; SQL authorization already reads the live value.

## Local validation

```sh
node --test scripts/store-modules.sql.test.mjs
```

The runner follows existing catalog tests: disposable PostgreSQL, private Unix socket,
TCP disabled, PG* environment overrides removed, tools mandatory and no skipped tests.
It uses catalog migrations plus a clearly labeled LOCAL fixture modeling the manually
reported new tables. It never connects to Supabase or reads .env. Services/Staff UUID
PK, bigint store_id, zero sort_order and true is_active defaults match the user's
confirmed schema and are exercised with real INSERTs. Fixture timestamp defaults,
other flags/defaults and unconfirmed constraints remain local testing assumptions,
not independent verification of the remote schema.

Tests cover legacy/explicit roles, spoofing, tenant/owner changes, disabled/missing/NULL
flags, public active reads, private drafts, denied public writes, Super Admin/store
management, restricted columns/helpers, preflight failures and safe reapplication.
Existing catalog columns, policies, grants, view/RPC definitions and all fixture data
are compared before/after. No Payments migrations are loaded. Remote grants, Auth
configuration and public API behavior still require manual verification.
