-- LOCAL TEST FIXTURE ONLY. The production publications table already exists.
create table public.publications (
  id uuid primary key default gen_random_uuid(), store_id bigint references public.stores(id),
  title text, slug text, summary text, category text,
  publication_type text default 'pdf' constraint publications_publication_type_check check(publication_type in ('pdf','article')), content text,
  pdf_storage_path text, pdf_original_name text, pdf_size_bytes bigint, cover_storage_path text,
  status text default 'draft', display_order integer default 0, published_at timestamptz,
  created_by uuid references auth.users(id), created_at timestamptz default now(), updated_at timestamptz default now()
);
-- Exact timestamp-only trigger definition supplied by the user from Supabase.
create function public.set_publications_updated_at() returns trigger
language plpgsql set search_path='' as $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;
create trigger trg_publications_updated_at before update on public.publications
for each row execute function public.set_publications_updated_at();
create schema storage;
create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text,unique(bucket_id,name));
alter table storage.objects enable row level security;
grant usage on schema storage to anon,authenticated;
grant select,insert,update,delete on storage.objects to anon,authenticated;
insert into storage.buckets values('publication-files','publication-files',false,10485760,array['application/pdf']);
-- Deliberately permissive historical policies: the migration MUST constrain them.
create policy historical_storage_allow on storage.objects for all to authenticated using(true) with check(true);
create policy historical_anon_storage_allow on storage.objects for select to anon using(true);
create policy historical_publications_allow on public.publications for all to authenticated using(true) with check(true);
create policy historical_anon_publications_allow on public.publications for select to anon using(true);
grant select(pdf_storage_path),update(store_id) on public.publications to public;
insert into public.publications(id,store_id,title,slug,publication_type,created_at,updated_at,published_at,created_by,
  pdf_storage_path,pdf_original_name,pdf_size_bytes,content,cover_storage_path) values
  ('10000000-0000-4000-8000-000000000001',1,'LOCAL DRAFT','local-draft','pdf',
    '2020-01-01Z','2022-01-01Z','2021-01-01Z','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',null,null,null,null,null),
  ('20000000-0000-4000-8000-000000000002',2,'FOREIGN DRAFT','foreign-draft','article',
    '2020-01-02Z','2022-01-02Z','2021-01-02Z','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    '2-local-b/publications/20000000-0000-4000-8000-000000000002-foreign-draft/documento-40000000-0000-4000-8000-000000000004.pdf',
    'historical.pdf',100,'Existing article body','historical-cover.webp');
