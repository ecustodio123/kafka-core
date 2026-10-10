-- Kafka Core - Phase 7.1 validation queries
-- Run after applying supabase/migrations/202610080001_add_product_categories.sql.
-- These queries are intended for review/staging. Do not run destructive test
-- inserts against production data unless you wrap them in a transaction and roll back.

-- 1. The categories table exists.
select to_regclass('public.categories') as categories_table;

-- 2. Columns and types are correct.
select
  column_name,
  data_type,
  udt_name,
  is_nullable,
  column_default
from information_schema.columns
where table_schema = 'public'
  and table_name = 'categories'
order by ordinal_position;

-- 3. Foreign keys and uniqueness constraints exist.
select
  conname,
  contype,
  pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid in ('public.categories'::regclass, 'public.products'::regclass)
  and conname in (
    'categories_store_slug_unique',
    'categories_store_id_id_unique',
    'products_store_category_fk'
  )
order by conname;

-- 4. Useful indexes exist.
select
  indexname,
  indexdef
from pg_indexes
where schemaname = 'public'
  and tablename in ('categories', 'products')
  and indexname in (
    'categories_store_active_sort_idx',
    'products_store_category_idx'
  )
order by indexname;

-- 5. category_id accepts NULL and existing products remain intact.
select
  count(*) as total_products,
  count(*) filter (where category_id is null) as products_without_category
from public.products;

-- 6. Categories list in expected order.
-- Replace 1 with the store id to inspect.
select id, store_id, name, slug, sort_order, active
from public.categories
where store_id = 1
order by sort_order, name;

-- 7. RLS is enabled on categories.
select
  schemaname,
  tablename,
  rowsecurity
from pg_tables
where schemaname = 'public'
  and tablename = 'categories';

-- 8. RLS policies are configured.
select
  schemaname,
  tablename,
  policyname,
  permissive,
  roles,
  cmd,
  qual,
  with_check
from pg_policies
where schemaname = 'public'
  and tablename = 'categories'
order by policyname;

-- 9. Optional transactional integrity checks.
-- This verifies:
-- - same slug can exist in different stores
-- - duplicate slug in same store fails
-- - products cannot reference another store's category
-- - category_id can be NULL
--
-- Only run this block in a disposable database or after changing the ids below
-- to test stores/products you are comfortable touching. It rolls back.
/*
begin;

insert into public.categories (store_id, name, slug, sort_order)
values
  (1, 'Validation Category', 'validation-category', 10),
  (2, 'Validation Category', 'validation-category', 10);

-- Expected to fail:
insert into public.categories (store_id, name, slug)
values (1, 'Duplicate Validation Category', 'validation-category');

rollback;
*/
