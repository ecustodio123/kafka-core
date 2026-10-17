# Product creation idempotency (catalog, stage 2A)

Local implementation only. Review and manually apply
`migrations/202610160001_product_creation_idempotency.sql` before deploying this
Admin version. No remote SQL, Storage changes, payment changes or deployment are
part of this work. There is no fallback to a traditional INSERT if the RPC fails
or is missing. Existing SQL INSERT clients remain compatible but not idempotent.

## Schema provenance

The owner confirmed products/stores identity bigint IDs, nullable products.store_id
and stores.owner_user_id, UNIQUE products(store_id,id), UUID categories with a
composite store/category FK, numeric price and existing discount/rating checks,
enabled RLS and no custom catalog triggers. No operation table/function existed.
The isolated fixture reproduces those facts and applies the actual catalog RLS,
category and offer migrations. It is not a dump or verification of the remote DB.

## RPC and security

`create_product_idempotent(p_store_id bigint, p_operation_id uuid, p_input jsonb)`
is SECURITY DEFINER with empty search_path and qualified non-catalog references.
Only authenticated has EXECUTE (aside from the function owner). Anonymous callers
and missing auth.uid() fail. Current stores.owner_user_id must equal auth.uid();
the store SHARE lock prevents concurrent owner changes during authorization.
The persisted created_by must also equal auth.uid(), including recovery.
Ownership transfer does not grant replay access to the original owner's operation.

`product_creation_operations` has RLS enabled, no client policies and explicit
table privilege revocations, including service_role default grants. Its primary
key is (store_id, operation_id). A composite product reference uses separate
nullable product_store_id/product_id columns constrained to the operation store.
ON DELETE SET NULL clears both reference columns, not the operation's store_id,
preserving a consumed receipt on product deletion even on PostgreSQL 14. Store
deletion cascades receipts along with the store's catalog; deleted stores are not
a recoverable tenant. No auth.users cascade deletes the creator's receipt.

Input requires exactly name, description, price, discount_active, discount_price,
visual_rating, category_id and available. Types are strict; strings are trimmed,
empty description becomes NULL, UUID/numbers/booleans are canonical JSONB values.
Name is 1..120 characters, description at most 500 (existing Admin limits).
Price is nonnegative numeric. Discount must fit numeric(10,2), be positive and
below price; active discounts require a value. Rating is NULL or 0..5 fitting one
decimal. Excess discount/rating precision is rejected rather than silently rounded.
Category must belong to the same store on a new creation; the composite FK also
enforces this. active=true and image_path=NULL are server-selected, never inputs.

The transaction locks store -> operation and does not row-lock an existing product.
INSERT ON CONFLICT DO NOTHING serializes the unique operation; the following
SELECT FOR UPDATE sees the committed receipt under normal READ COMMITTED.
At stronger isolation, callers must handle transaction serialization errors by
retrying the SAME operation, never generating another UUID automatically.
New receipt/product/link commit together or roll back together. Replays compare
the canonical ORIGINAL request, never edited product fields, then read the current
product. They do not update receipt/product data. A deletion racing a replay can
still happen after its read; recovery is not a promise that the product cannot
subsequently be deleted. No replay locks product before operation, avoiding an
inverse lock dependency with the deletion FK action.

Result: `{status:'found', product, replayed}` or `{status:'deleted', product:null}`.
A consumed deleted operation is never recreated. Different original creator or
payload raises a generic PT409 conflict without returning the product. Missing
authorization raises 42501. Validation errors do not include raw input.

For refresh recovery ONLY, p_input=NULL performs an authorized lookup without
inserting anything. An absent receipt returns `{status:'not_found', product:null}`;
this is not proof that an older request cannot still commit. Keep the same UUID.
Lookup can return a product only for the current owner who also created the receipt.
The UUID is an identifier, not a bearer credential.

## Admin integration

products.ts calls the RPC with a 15-second abort deadline. Aborting a request does
not prove rollback. ProductsPage keeps an immediate in-flight guard and disables
form controls during save. The coordinator freezes the original in-memory request
across uncertain retries and persists ONLY the UUID in sessionStorage, scoped by
owner and store. It stores no catalog text, files, JWTs, keys or passwords. Failure
to persist the UUID fails closed before sending the create RPC.

After refresh, opening Nuevo producto first looks up the pending UUID. If found,
the page opens that product in edit mode. If not found, it retains the same UUID
for the next submission; a late incompatible commit produces a SQL conflict, not
a duplicate. After an uncertain save with changed form data, use the recovery
opening before continuing. No token/UUID is placed in a URL or log.

The confirmed product ID/list state is retained before the existing image steps.
An image failure therefore leaves editing mode, not a new INSERT on retry. Image
upload, replacement and image_path linking are otherwise unchanged in stage 2A.
Editing products still uses the existing store-scoped UPDATE service.

## Local verification

```sh
npm run test:products:creation:unit
npm run test:products:creation:sql
npx tsc -b
npm run build
npm run lint
git diff --check
```

The SQL runner requires PostgreSQL 15+ for the existing security_invoker catalog
view. It prefers installed Homebrew PostgreSQL 16; otherwise uses PATH. An explicit
local binary directory can be selected with CATALOG_PG_BIN. Missing tools cause a
failure, never a skip. Tests create/destroy a disposable cluster on a private Unix
socket with TCP disabled, strip PG* environment overrides and require no credentials.
No Payments migrations or test runners are loaded. Real concurrent connections test
same-key serialization and conflicting payloads; ACL tests include permissive object
creation defaults to verify explicit revocations.

## Residual limits / separate follow-up

- sessionStorage survives refresh in the same tab, not clearing site data, closing
  the tab/session or another device. Lost operation identifiers cannot be recovered
  by guessing names/prices. A new UUID is a new logical creation, not global duplicate
  detection. Catalog fields can legitimately be identical across different products.
- Pending UUIDs survive sign-out in that tab but are partitioned by owner/store;
  server authorization remains mandatory. They contain no authentication material.
- Browser storage/XSS security and current remote RLS/ACLs still require operational
  verification. Local tests do not verify the deployed Supabase configuration.
- Storage remains nontransactional with PostgreSQL. Uploaded unlinked files,
  replacement cleanup and ambiguous image_path responses remain stage 2 follow-up;
  this migration neither deletes images nor guarantees orphan-free uploads.
- Receipts are retained while the store exists; no automatic expiration/cleanup is
  introduced, since removing them could re-enable the same logical creation.
- products and kafka_commerce_products columns, catalog policies, buckets, existing
  image paths and Commerce consumers are unchanged. Existing independent writers can
  bypass this workflow; only clients using the RPC receive its idempotency guarantee.
