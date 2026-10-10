# Kafka Core - Fase 7.1 Categorias

## Archivos

- `supabase/migrations/202610080001_add_product_categories.sql`
- `supabase/validation/phase-7-1-categories-validation.sql`

## Decision importante sobre tipos

El requerimiento original propuso `categories.store_id uuid`, pero el esquema real usado por este repositorio maneja `stores.id` y `products.store_id` como ids numericos compatibles con `bigint`. Por compatibilidad, la migracion crea:

```sql
store_id bigint not null references public.stores(id)
```

`categories.id` si es `uuid`, como se pidio.

## Cambios principales

- Crea `public.categories`.
- Agrega `products.category_id uuid null`.
- Agrega FK compuesta `products(store_id, category_id)` hacia `categories(store_id, id)`.
- Mantiene `category_id` opcional para no romper productos existentes.
- Impide borrar categorias referenciadas por productos; para conservar compatibilidad, se deben inactivar con `active = false`.
- Agrega unique `(store_id, slug)`.
- Agrega unique `(store_id, id)` para soportar la FK compuesta.
- Agrega indices para listar categorias y consultar productos por categoria.
- Habilita RLS en `categories`.

## RLS

La migracion asume que Fase 6 ya agrego `stores.owner_user_id`.

Policies incluidas:

- `anon` puede leer categorias `active = true`.
- usuarios autenticados pueden leer/crear/actualizar/eliminar categorias solo de tiendas donde `stores.owner_user_id = auth.uid()`.

Limitacion actual: no existe una columna `stores.active`, `stores.published` o similar. Por eso la lectura publica solo puede restringirse por `categories.active`. Si Kafka Core necesita ocultar tiendas completas, conviene agregar un flag de publicacion en `stores` en una fase posterior y ajustar esta policy.

## Como aplicar

Desde Supabase SQL Editor:

1. Abrir `supabase/migrations/202610080001_add_product_categories.sql`.
2. Revisar el SQL.
3. Ejecutarlo una vez.
4. Ejecutar consultas de `supabase/validation/phase-7-1-categories-validation.sql`.

Desde Supabase CLI, si luego se inicializa el proyecto:

```bash
supabase db push
```

## Riesgos de compatibilidad

- Si `stores.id` no es `bigint` en el entorno real, ajustar `categories.store_id` al tipo exacto antes de aplicar.
- Si `products.store_id` no tiene el mismo tipo que `stores.id`, la FK compuesta fallara.
- Si existen policies antiguas con los mismos nombres, la migracion las reemplaza.
- La policy publica de categorias activas puede exponer nombres de categorias activas de cualquier tienda hasta que exista un flag de publicacion por tienda.

## Que necesitara Kafka Admin despues

- Tipos para `Category`.
- Servicio `categories.ts` para CRUD por tienda autenticada.
- Campo `category_id` en el formulario de productos.
- Filtros/listados por categoria.
- Manejo de categorias inactivas sin romper productos existentes.
