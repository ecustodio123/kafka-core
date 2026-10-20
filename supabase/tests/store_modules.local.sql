-- LOCAL FIXTURE ONLY. Supplements product_creation.local.sql, never a remote DB.
alter table auth.users add column raw_app_meta_data jsonb default '{}'::jsonb;
alter table auth.users add column raw_user_meta_data jsonb default '{}'::jsonb;
insert into auth.users(id,raw_app_meta_data,raw_user_meta_data) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','{}','{}'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','{"global_role":"admin"}','{}'),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','{"global_role":"super_admin"}','{}'),
  ('dddddddd-dddd-4ddd-8ddd-dddddddddddd','{"global_role":"admin"}','{}'),
  ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','{"global_role":null}','{}'),
  ('ffffffff-ffff-4fff-8fff-ffffffffffff','{}','{"global_role":"super_admin"}');
alter table public.stores add foreign key(owner_user_id) references auth.users(id);
insert into public.stores(name,slug,owner_user_id) values
  ('LOCAL NO FLAGS','local-no-flags','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  ('LOCAL INVALID ROLE','local-invalid-role','eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'),
  ('LOCAL SPOOFED ROLE','local-spoofed-role','ffffffff-ffff-4fff-8fff-ffffffffffff');

-- Simulate historical Supabase defaults, including unsafe default function ACLs.
alter default privileges grant execute on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
create table public.store_features (
  store_id bigint primary key references public.stores(id),
  services_enabled boolean default false, staff_enabled boolean default false,
  commerce_enabled boolean default false,
  created_at timestamptz default now(), updated_at timestamptz default now()
);
create table public.services (
  id uuid primary key default gen_random_uuid(),
  store_id bigint references public.stores(id), title text not null,
  description text, image_url text, sort_order integer default 0,
  is_active boolean default true,
  created_at timestamptz default now(), updated_at timestamptz default now()
);
create table public.staff (
  id uuid primary key default gen_random_uuid(),
  store_id bigint references public.stores(id), name text not null,
  title text, description text, image_url text, sort_order integer default 0,
  is_active boolean default true,
  created_at timestamptz default now(), updated_at timestamptz default now()
);
alter table public.store_features enable row level security;
alter table public.services enable row level security;
alter table public.staff enable row level security;
insert into public.store_features(store_id,services_enabled,staff_enabled,commerce_enabled) values
  (1,true,false,true), (2,false,true,true), (4,true,true,true), (5,false,null,false);
insert into public.services(id,store_id,title,is_active) values
  ('10000000-0000-4000-8000-000000000001',1,'LOCAL PUBLIC SERVICE',true),
  ('10000000-0000-4000-8000-000000000002',1,'LOCAL DRAFT SERVICE',false),
  ('10000000-0000-4000-8000-000000000003',2,'LOCAL DISABLED SERVICE',true);
insert into public.staff(id,store_id,name,is_active) values
  ('20000000-0000-4000-8000-000000000001',1,'LOCAL DISABLED STAFF',true),
  ('20000000-0000-4000-8000-000000000002',2,'LOCAL PUBLIC STAFF',true),
  ('20000000-0000-4000-8000-000000000003',2,'LOCAL DRAFT STAFF',false);
