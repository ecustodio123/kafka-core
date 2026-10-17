-- Catalog only. Apply manually after reviewing the confirmed products schema.
begin;

create table public.product_creation_operations (
  store_id bigint not null references public.stores(id) on delete cascade,
  operation_id uuid not null,
  created_by uuid not null,
  request_payload jsonb not null check (jsonb_typeof(request_payload) = 'object'),
  product_store_id bigint,
  product_id bigint,
  created_at timestamptz not null default now(),
  primary key (store_id, operation_id),
  constraint product_creation_reference_valid check (
    (product_id is null and product_store_id is null)
    or (product_id is not null and product_store_id is not null
      and product_store_id = store_id)
  ),
  -- Both reference columns become NULL on deletion, while store_id and the
  -- consumed operation remain intact. Compatible with PostgreSQL 14 as well.
  foreign key (product_store_id, product_id)
    references public.products(store_id, id) on delete set null
);

create index product_creation_operations_product_idx
  on public.product_creation_operations(product_store_id, product_id);
alter table public.product_creation_operations enable row level security;
revoke all on public.product_creation_operations from public, anon, authenticated, service_role;

create function public.create_product_idempotent(
  p_store_id bigint, p_operation_id uuid, p_input jsonb default null
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  caller uuid := auth.uid();
  owner_id uuid;
  receipt public.product_creation_operations%rowtype;
  product public.products%rowtype;
  canonical jsonb;
  normalized_name text;
  normalized_description text;
  category uuid;
  price_value numeric;
  discount_value numeric;
  rating_value numeric;
  inserted boolean;
begin
  if caller is null or p_store_id is null or p_store_id <= 0
    or p_operation_id is null then
    raise exception using errcode = '42501', message = 'Operacion no autorizada';
  end if;
  -- Store -> operation. SHARE prevents an owner change during authorization;
  -- concurrent creations remain possible. Never row-lock an existing product.
  select s.owner_user_id into owner_id from public.stores s
    where s.id = p_store_id for share;
  if not found or owner_id is distinct from caller then
    raise exception using errcode = '42501', message = 'Operacion no autorizada';
  end if;

  -- NULL is recovery-only: it can NEVER create an operation or product.
  if p_input is not null then
    if jsonb_typeof(p_input) <> 'object' then
      raise exception using errcode = '22023', message = 'Datos de producto invalidos';
    end if;
    if exists (select 1 from jsonb_object_keys(p_input) k where k not in (
      'name','description','price','discount_active','discount_price',
      'visual_rating','category_id','available'))
      or not (p_input ?& array['name','description','price','discount_active',
        'discount_price','visual_rating','category_id','available']) then
      raise exception using errcode = '22023', message = 'Datos de producto invalidos';
    end if;
    if jsonb_typeof(p_input->'name') <> 'string'
      or jsonb_typeof(p_input->'description') not in ('string','null')
      or jsonb_typeof(p_input->'price') <> 'number'
      or jsonb_typeof(p_input->'discount_active') <> 'boolean'
      or jsonb_typeof(p_input->'available') <> 'boolean'
      or jsonb_typeof(p_input->'discount_price') not in ('number','null')
      or jsonb_typeof(p_input->'visual_rating') not in ('number','null')
      or jsonb_typeof(p_input->'category_id') not in ('string','null') then
      raise exception using errcode = '22023', message = 'Datos de producto invalidos';
    end if;
    normalized_name := btrim(p_input->>'name');
    normalized_description := nullif(btrim(p_input->>'description'), '');
    price_value := (p_input->>'price')::numeric;
    discount_value := (p_input->>'discount_price')::numeric;
    rating_value := (p_input->>'visual_rating')::numeric;
    begin
      category := (p_input->>'category_id')::uuid;
    exception when invalid_text_representation then
      raise exception using errcode = '22023', message = 'Datos de producto invalidos';
    end;
    if length(normalized_name) not between 1 and 120
      or length(normalized_description) > 500 or price_value < 0
      or (discount_value is not null and (discount_value <= 0
        or discount_value >= price_value or discount_value > 99999999.99
        or discount_value <> trunc(discount_value, 2)))
      or ((p_input->>'discount_active')::boolean and discount_value is null)
      or (rating_value is not null and (rating_value < 0 or rating_value > 5
        or rating_value <> trunc(rating_value, 1))) then
      raise exception using errcode = '22023', message = 'Datos de producto invalidos';
    end if;
    canonical := jsonb_build_object('name', normalized_name,
      'description', normalized_description, 'price', price_value,
      'discount_active', (p_input->>'discount_active')::boolean,
      'discount_price', discount_value, 'visual_rating', rating_value,
      'category_id', category, 'available', (p_input->>'available')::boolean);

    insert into public.product_creation_operations
      (store_id, operation_id, created_by, request_payload)
      values (p_store_id, p_operation_id, caller, canonical)
      on conflict (store_id, operation_id) do nothing;
    inserted := found;
  end if;

  select o.* into receipt from public.product_creation_operations o
    where o.store_id = p_store_id and o.operation_id = p_operation_id for update;
  if not found then
    return jsonb_build_object('status', 'not_found', 'product', null);
  end if;
  if receipt.created_by is distinct from caller
    or (p_input is not null and receipt.request_payload is distinct from canonical) then
    raise exception using errcode = 'PT409', message = 'Conflicto de operacion';
  end if;

  if coalesce(inserted, false) then
    if category is not null and not exists (select 1 from public.categories c
      where c.store_id = p_store_id and c.id = category) then
      raise exception using errcode = '22023', message = 'Categoria no disponible';
    end if;
    insert into public.products (store_id, name, description, price,
      discount_active, discount_price, visual_rating, category_id,
      available, active, image_path)
    values (p_store_id, normalized_name, normalized_description, price_value,
      (canonical->>'discount_active')::boolean, discount_value, rating_value,
      category, (canonical->>'available')::boolean, true, null)
    returning * into product;
    update public.product_creation_operations o
      set product_store_id = p_store_id, product_id = product.id
      where o.store_id = p_store_id and o.operation_id = p_operation_id;
  else
    if receipt.product_id is null then
      return jsonb_build_object('status', 'deleted', 'product', null);
    end if;
    select p.* into product from public.products p
      where p.store_id = p_store_id and p.id = receipt.product_id;
    if not found then
      raise exception 'Resultado de operacion no disponible';
    end if;
  end if;
  -- Explicit projection: no future product column is implicitly exposed.
  return jsonb_build_object('status', 'found', 'replayed', not coalesce(inserted, false),
    'product', jsonb_build_object('id', product.id, 'store_id', product.store_id,
      'name', product.name, 'description', product.description, 'price', product.price,
      'discount_active', product.discount_active, 'discount_price', product.discount_price,
      'visual_rating', product.visual_rating, 'image_path', product.image_path,
      'category_id', product.category_id, 'available', product.available,
      'active', product.active, 'created_at', product.created_at));
end;
$$;

revoke all on function public.create_product_idempotent(bigint, uuid, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.create_product_idempotent(bigint, uuid, jsonb)
  to authenticated;
commit;
