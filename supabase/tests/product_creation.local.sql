-- Isolated local schema based on the catalog facts confirmed by the owner.
-- Never run this fixture against an existing database.
create role anon;
create role authenticated;
create role service_role;
create schema auth;
create schema extensions;
create table auth.users(id uuid primary key);
grant usage on schema auth to authenticated;
create function auth.uid() returns uuid language sql stable as
$$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

create table public.stores (
  id bigint generated always as identity primary key,
  name varchar(255) not null,
  slug varchar(255) not null,
  owner_user_id uuid,
  created_at timestamptz default now()
);
create table public.products (
  id bigint generated always as identity primary key,
  store_id bigint references public.stores(id) on delete cascade,
  name varchar(255) not null,
  description text,
  price numeric,
  image_path text,
  available boolean default true,
  active boolean default true,
  created_at timestamptz default now(),
  unique(store_id, id)
);
insert into public.stores(name, slug, owner_user_id) values
  ('LOCAL A', 'local-a', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  ('LOCAL B', 'local-b', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
