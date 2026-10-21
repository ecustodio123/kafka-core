# Catalog deletion and recoverable media cleanup

Operator-confirmed remote state: migration applied; catalog-delete deployed with
both flags OFF and HTTP 503 verified. This was not independently queried here.
Updated UI publication remains pending. Deployment steps below describe the rollout,
not instructions to reapply the already applied migration.
No historical images are swept. Payments and Commerce code/contracts are unchanged.

## Design

- Authenticated `catalog-delete` verifies the bearer with Auth.getUser. Browser
  input never supplies actor, bucket, path, cleanup claim or service credentials.
- All four public SQL RPCs are service_role-only SECURITY DEFINER with an empty
  search_path. Each checks the CURRENT store owner and trusted Auth role in SQL.
  Only explicit admin/super_admin roles are accepted, in addition to current
  ownership. Missing, NULL or unknown roles are denied. A Super Admin does NOT
  gain foreign catalog access. Existing owners without an explicit role cannot
  delete or run cleanup until a trusted administrator assigns their role.
  Existing creation/edit authorization is unchanged; no roles are assigned here.
- `delete_catalog_entity` locks the store (SHARE), operation advisory key and
  entity row. It deletes and persists the consumed operation/cleanup task in one
  transaction. Same actor/store/operation/payload replays; incompatible reuse
  conflicts. The UUID is persisted BEFORE HTTP, scoped by SDK user/store/entity
  in sessionStorage; no binary, payload or credentials are added there.
- Categories with associated products fail, even if the UI count is stale. The
  validated composite FK must be non-cascading. Unknown destructive incoming
  dependencies abort migration; 2A's consumed-operation SET NULL is preserved.
- Old references are automatically queued AFTER pointer replacement/removal or
  record deletion. No network call occurs inside PostgreSQL. A failed SQL statement
  rolls back the record, operation receipt and queued work together.
- A cleanup claim checks ALL products/categories/services/staff and the reviewed
  kafka_commerce_products view, bypassing RLS
  internally without exposing their data. References normalize to a bucket/path
  after bounded percent decoding and query/fragment removal. Dot segments, duplicate
  slashes and unsupported forms fail closed rather than being guessed. Identical
  filenames in different folders are distinct objects. Malformed/over-nested,
  external or opaque references prevent cleanup
  globally rather than assuming they cannot alias a file. SQL never deletes
  storage.objects rows or files; only Storage.remove runs in the Edge Function.

## Closing the reference-check/delete race

One transaction-level advisory media lock serializes reference publication,
queue insertion and cleanup claims. Claims scan committed references without
locking entity rows. A permanent retired marker is committed BEFORE Storage HTTP.
Triggers reject future references to that exact bucket/path, and Storage object
reuse of the exact retired bucket/path. The marker is NEVER cleared after failure.

Product reference triggers acquire the category FK KEY SHARE before the media
lock, avoiding a parent-delete/child-insert lock inversion. Worker order is store
SHARE -> media advisory -> job row. Entity deletion is store SHARE -> operation
advisory -> entity row -> media advisory -> job insert. Workers never lock entity
rows, and reference guards never lock job rows. Do not add inverse locks in future
writers. Bulk/multi-statement privileged maintenance needs its own lock audit.

Only one claim wins for two minutes. After that, an explicit retry can reclaim
the SAME permanently retired path. DELETE may safely be repeated if its response
was lost: new references/reuploads remain forbidden. This is NOT payment retry
semantics. A late finisher cannot overwrite a newer claim token. Ownership/role
revocation stops subsequent RPCs; it cannot cancel a Storage request already sent.

## Images retained rather than guessed

Owned candidates must match the REAL store/entity IDs, numeric legacy paths or
descriptive paths. Products store relative paths; categories store public URLs
matching the configured project origin. External/signed/query/encoded URLs,
unknown folder UUIDs, unsupported filenames and mismatched store/entity IDs are
retained_unverified, not removed. Image reads and existing paths remain unchanged.

The proof covers the four existing catalog image columns plus the Commerce
image_path projection, not arbitrary JSON,
backups, external aliases/proxies or future tables. Migration aborts on unknown
public text image/logo/avatar columns; operators must still inventory all actual
references before enabling cleanup. Once a path is
retired, new opaque/external image references are rejected because their target
cannot be proved safe; existing opaque references are retained and block cleanup.
Standard project Storage public URLs and relative product paths remain supported.
Select a new UUID-named upload for a retired path; do not weaken the guard.

## Commerce compatibility and conservative retention

The repository migration 202610100001 defines kafka_commerce_products as a view
directly selecting products.image_path. Product uploads use product-images, so
that reviewed view has the same relative paths and can share the same objects.
The reported remote row counts/example path alone do NOT prove relation kind,
view lineage, bucket, write paths or exclusivity.

Preflight now inventories kafka_commerce_products.image_path and requires TEXT.
Cleanup additionally checks the exact reviewed view definition using
md5(pg_get_viewdef(oid,true)) under search_path='', accepting only:
- b90b085818ea02f9dfe71143dd81492b: verified locally against migration 202610100001.
- 2a6cd6a7bcdf87c59984816f26c429a8: production preflight confirmed manually by
  the operator as a VIEW directly projecting products.image_path, with no JOIN or
  additional sources; only final_price/discount_percent/in_offer are calculated.

The complete remote DDL was not supplied or independently queried here; local
tests cover the allowlist predicate, not a recreation of that remote definition.
Both verified contracts preserve image_path provenance in products/product-images.
This is a fail-closed compatibility check, not a
cryptographic trust boundary against privileged DDL. Every claim rechecks it.
If the relation is a table, partitioned table, materialized view, missing, or a
different view, ALL physical cleanup candidates remain retained_shared without
retiring their paths. PostgreSQL rendering/version differences may also cause
safe retention. Product/category record deletion remains possible.

No Commerce schema, view, data, RLS, API or writer is modified. Independent
Commerce writers would need a separately reviewed publication/retirement protocol
before physical cleanup could safely proceed; scanning current rows alone cannot
close their concurrent-reference race. Never approve a new definition hash solely
to bypass retention. Review the definition, dependencies, bucket and writer
behavior first. Keep cleanup disabled until the remote contract is verified.

## Partial failures and UI

The UI confirms before deletion; pending product image operations must be resolved
or discarded first. Only a confirmed backend deletion removes the displayed row.
Storage failures return deleted=true + cleanup=pending, not a false rollback.
SDK calls on the server have a 15-second deadline; browser invocation has a
30-second deadline. A deadline never proves SQL rollback or file survival: the
same operation/retired path is reused for explicit recovery.
The recovery panel explicitly retries the same UUID and survives refresh within
the same browser session. It never runs automatically. Same-session double sends
are blocked; backend idempotency covers concurrent HTTP requests/tabs sharing a key.

Cleanup processes at most five tasks per call; a sixth keeps the result pending.
Shared files remain retained_shared. Empty/no-image operations complete without
Storage. Browser code no longer calls Storage.remove for category compensation or
replacement: a lost pointer response is not permission to delete the candidate.

Replacing an image queues its previous confirmed reference; the UI asks the worker
to clean it and reports failures separately from successful saving. The worker can
also be invoked explicitly for replacements with action=cleanup. No scheduler is
introduced. Historical files and unlinked uploads with an unconfirmed pointer are
retained; this is not an orphan-free upload registry or a bulk garbage collector.
Category INSERT response ambiguity still requires manual list recovery; only
product creation retains 2A's existing exactly-once operation mechanism.

## Manual preflight (read-only; run yourself in Supabase)

```sql
select schemaname,tablename,policyname,roles,cmd,qual,with_check
from pg_policies where (schemaname='public' and tablename in
 ('products','categories','stores','services','staff'))
 or (schemaname='storage' and tablename='objects') order by 1,2,3;

select conrelid::regclass as source,confrelid::regclass as target,
       conname,pg_get_constraintdef(oid)
from pg_constraint where contype='f' and confrelid in
 ('public.products'::regclass,'public.categories'::regclass);

select table_schema,table_name,column_name,data_type
from information_schema.columns where table_schema='public'
and column_name ~* '(image|avatar|logo)' order by 1,2,3;

select tgrelid::regclass,tgname,pg_get_triggerdef(oid)
from pg_trigger where not tgisinternal and tgrelid in
 ('public.products'::regclass,'public.categories'::regclass,
  'public.services'::regclass,'public.staff'::regclass,'storage.objects'::regclass);

select id,public,file_size_limit,allowed_mime_types from storage.buckets
where id in ('product-images','category-images');

-- Relation kind and complete definition; execute with a fixed search_path so the
-- definition signature is comparable with the reviewed local PostgreSQL fixture.
begin read only;
set local search_path='';
select c.relkind,c.relrowsecurity,c.reloptions,
  case when c.relkind in ('v','m') then pg_get_viewdef(c.oid,true) end as definition,
  case when c.relkind='v' then md5(pg_get_viewdef(c.oid,true)) end as definition_md5
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relname='kafka_commerce_products';
rollback;

-- Inventory bucket matches and shared references, not proof of exclusive ownership.
-- A missing object may be an old path, inaccessible asset or different origin.
select k.image_path,
  array(select distinct o.bucket_id from storage.objects o
    where o.name=k.image_path) as matching_buckets,
  (select count(*) from public.products p where p.image_path=k.image_path) as product_references
from public.kafka_commerce_products k where k.image_path is not null
order by k.image_path limit 150;
```

Review default/function grants, table ownership and public_schema inventory too.
Do not assume the checked-in RLS equals effective production policies. The
repository's category DELETE policy is owner-scoped, but a reported remote broad
policy is handled by NEW restrictive policies, not by trusting that old definition.
INSERT is AND-restricted for authenticated users to current owner + real category
in that store, accepting both {store_id}/{category_uuid}/{file} and
{store_id}-{slug}/categories/{category_uuid}-{slug}/{file}. IDs are compared as
text (no unsafe bigint/UUID casts); malformed/traversal paths are rejected. Slugs
are normalized path labels, not authorization identifiers. Anonymous category
INSERT is denied separately, without requiring anonymous SELECT on stores.
Existing owner-based category uploads need no new global role requirement.

## Deployment steps (NOT executed)

1. Back up DB references and required Storage originals. Resolve the preflight
   discrepancies, unreviewed references, custom triggers and destructive FKs first.
2. Apply `migrations/202610210001_catalog_deletion.sql` manually as postgres
   (trusted BYPASSRLS required; inherited client grants also abort safely). It
   revokes direct client DELETE on products/categories and denies direct file
   DELETE and UPDATE/move/upsert in the two buckets even when an old permissive
   policy says ALL. Current catalog uploads use unique paths and upsert=false.
   Restrictive category INSERT checks owner/category even if old policies allow
   the entire bucket; no additional permissive policy broadens upload access.
   Other buckets and catalog read/update contracts retain their policies.
   A coordinated rollout/maintenance window is required: deploy the function with
   flags false and the updated UI before changing permissions, then apply SQL and
   configure the origin. Old browser tabs must reload; their old category cleanup
   requests will intentionally be denied. Enable flags only after isolated checks.
3. Set the PUBLIC project origin once from SQL Editor (not a credential):

   ```sql
   update catalog_media.settings
   set storage_base_url='https://YOUR_PROJECT.supabase.co' where singleton;
   ```

   The cleanup claim compares this value with SUPABASE_URL's origin supplied
   exclusively by the backend. NULL/mismatch blocks physical cleanup for both
   buckets, preventing an incorrect manual project URL from authorizing deletion.
   Custom domains require a separately reviewed origin rule.
4. Verify EXECUTE is false for anon/authenticated and true for service_role on
   the four catalog RPCs. Verify clients cannot read the private schema/tables.
5. Deploy `catalog-delete` manually only after review. Required server variables:
   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CATALOG_DELETE_ALLOWED_ORIGINS (comma
   separated, e.g. https://kafka-core.pages.dev,http://127.0.0.1:5174).
   CATALOG_DELETE_ENABLED and CATALOG_MEDIA_CLEANUP_ENABLED both default false.
   Configure them explicitly only in an authorized rollout with test-owned data.
6. Validate with a dedicated noncommercial store: delete no-image product, block
   nonempty category, preserve a shared image, force Storage failure and retry.
   Verify actual Storage API behavior, restrictive policies, triggers and custom
   Auth roles before enabling cleanup for customer stores. Do not test on real
   customer records. Do not activate the UI deletion flow independently of
   RPC/function readiness: old direct category file deletion is intentionally denied.

Upload permission compatibility was checked against the installed Storage SDK and
[Supabase access-control documentation](https://supabase.com/docs/guides/storage/security/access-control):
new-object uploads use INSERT, whereas overwriting/upsert requires UPDATE too.
The implementation continues to use unique names and upsert=false. Actual hosted
Storage request behavior and effective policies still require a controlled check.

Request contract (JWT required):

```json
{"action":"delete","store_id":1,"kind":"product","entity_id":"7","operation_id":"UUID"}
```

For a category use kind=category and its UUID. For explicit replacement cleanup
use action=cleanup, same store/kind/entity_id; no operation_id is required and no
record is deleted. Response exposes only deleted, replayed and cleanup, never
paths/claims/other tenants. No remote calls or SQL were executed during development.

## Tests

```text
npm run test:catalog:sql
npm run test:catalog:edge
npm run test:catalog:browser
npm run test:products:images:browser
npm run test:products:images:typecheck
npx tsc -p tests/admin-navigation/tsconfig.json
npm run test:stores:browser
npm run build
npm run lint
git diff --check
```

PostgreSQL is disposable, TCP disabled, PG environment overrides removed, with
real concurrency and no skipped cases. Browser/Deno use synthetic Auth and HTTP;
no customer products, categories or Storage files are touched.

## Changed files

- supabase/migrations/202610210001_catalog_deletion.sql
- supabase/functions/catalog-delete/index.ts
- supabase/functions/catalog-delete/index_test.ts
- supabase/config.toml (catalog-delete section only)
- supabase/catalog-deletion.md
- src/services/catalogDeletion.ts
- src/services/categoryImages.ts
- src/components/CatalogDeletionRecovery.tsx
- src/features/products/ProductsPage.tsx
- src/features/categories/CategoriesPage.tsx
- scripts/catalog-deletion.sql.test.mjs
- tests/product-images/catalog-browser.html
- tests/product-images/catalog-harness.tsx
- tests/product-images/catalog-deletion.spec.ts
- tests/product-images/product-images.spec.ts
- package.json (three local test commands only)
