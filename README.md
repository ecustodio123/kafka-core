# Kafka Admin

Panel administrativo reutilizable para Kafka Core. Esta iteracion implementa React conectado a Supabase, CRUD inicial de productos, Auth basico para resolver la tienda del usuario, subida de imagenes con Supabase Storage y gestion de categorias.

## Stack

- React
- Vite
- TypeScript
- Tailwind CSS
- Supabase JS

## Configuracion local

1. Instala dependencias:

```bash
npm install
```

2. Crea un archivo `.env` local usando `.env.example` como referencia:

```bash
VITE_SUPABASE_URL=https://tu-proyecto.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=tu_publishable_key
```

No uses `service_role`, password de base de datos ni secretos administrativos en el frontend.

3. Ejecuta el SQL de Fase 6 en Supabase SQL Editor:

```text
supabase/phase-6-auth-rls.sql
```

Ese script agrega `stores.owner_user_id`, habilita RLS y crea policies para que un usuario autenticado administre solo productos de su tienda.

4. Ejecuta el SQL de Fase 7 en Supabase SQL Editor:

```text
supabase/phase-7-storage.sql
```

Ese script agrega `products.image_path`, crea el bucket publico `product-images` y configura policies para que cada usuario autenticado solo pueda subir imagenes bajo la carpeta de su tienda.

Las imagenes nuevas de productos se guardan con rutas descriptivas:

```text
{store_id}-{store_slug}/products/{product_id}-{product_slug}/principal-{timestamp}.webp
```

Las rutas antiguas, por ejemplo `{store_id}/{product_id}/image.webp`, siguen resolviendose porque `products.image_path` guarda el path relativo dentro del bucket.

5. Ejecuta el SQL de imagenes de categorias en Supabase SQL Editor:

```text
supabase/phase-7-3-category-images.sql
```

Ese script asegura `categories.image_url`, crea el bucket publico `category-images` y configura policies para que cada usuario autenticado solo pueda subir, reemplazar o eliminar imagenes bajo la carpeta de su tienda.

Las imagenes nuevas de categorias se guardan con rutas descriptivas:

```text
{store_id}-{store_slug}/categories/{category_id}-{category_slug}/principal-{timestamp}.webp
```

`categories.image_url` guarda la URL publica completa. Las URLs antiguas siguen funcionando mientras el objeto original exista.

6. Crea un usuario desde Supabase Auth. Kafka Admin no permite registro publico.

7. Asocia ese usuario a una tienda:

```sql
update public.stores
set owner_user_id = 'USER_ID_DE_AUTH'
where id = 1;
```

8. Ejecuta el proyecto:

```bash
npm run dev
```

## Scripts

```bash
npm run dev
npm run lint
npm run build
npm run preview
npm run migrate:product-images -- --mode dry-run
npm run migrate:category-images -- --mode dry-run
```

Los scripts de migracion requieren `SUPABASE_URL` o `VITE_SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` solo en el entorno local. No guardes esas credenciales en el repositorio. Los respaldos JSONL generados en `migration-backups/` quedan ignorados por Git y deben conservarse localmente para rollback.

## Productos

La pantalla de productos permite:

- leer productos filtrados por la tienda asociada al usuario autenticado
- crear productos asociados automaticamente a esa tienda
- editar nombre, descripcion, precio y disponibilidad
- asignar una categoria o dejar el producto sin categoria
- subir una imagen por producto a Supabase Storage
- alternar Disponible/Agotado usando `available`

No hay eliminacion fisica en esta fase. Los productos nuevos se crean internamente con `active = true`; el negocio solo gestiona Disponible/Agotado.

## Categorias

La pantalla de categorias permite:

- listar categorias de la tienda autenticada
- crear categorias con slug generado automaticamente
- editar nombre, slug, orden y estado
- subir, reemplazar y quitar una imagen de categoria
- activar o desactivar categorias sin eliminar productos asociados
- ver cuantos productos estan asociados a cada categoria

El orden publico se controla con `sort_order`. Si una categoria esta inactiva, se conserva y puede seguir apareciendo al editar productos que ya la tienen asignada. Las imagenes de categorias se guardan en Supabase Storage y su URL publica queda en `categories.image_url`.

## Arquitectura

- `src/lib/supabase.ts`: instancia centralizada del cliente de Supabase.
- `src/services/categories.ts`: capa de acceso a datos para categorias.
- `src/services/categoryImages.ts`: subida y eliminacion segura de imagenes de categorias.
- `src/services/imageProcessing.ts`: validacion y conversion WebP reutilizable.
- `src/services/pathSlugs.ts`: normalizacion compartida de segmentos para rutas de Storage.
- `src/services/products.ts`: capa de acceso a datos para productos.
- `src/services/productImages.ts`: subida y resolucion de URLs publicas de imagenes.
- `src/services/stores.ts`: resolucion de tienda desde el usuario autenticado.
- `src/features/auth/AuthPage.tsx`: login con Supabase Auth.
- `src/features/categories/CategoriesPage.tsx`: UI y flujo CRUD de categorias.
- `src/features/products/ProductsPage.tsx`: UI y flujo CRUD de productos.
- `src/types/database.ts`: tipos minimos para las tablas usadas.
- `supabase/phase-6-auth-rls.sql`: SQL para Auth/RLS de esta fase.
- `supabase/phase-7-storage.sql`: SQL para Storage e imagenes de producto.
- `supabase/phase-7-3-category-images.sql`: SQL para Storage e imagenes de categoria.
- `supabase/product-images-migration-plan.md`: plan seguro para migrar rutas antiguas de imagenes de producto sin ejecutarlo automaticamente.
- `supabase/category-images-migration-plan.md`: plan seguro para migrar rutas antiguas de imagenes de categorias sin ejecutarlo automaticamente.
- `scripts/migrate-product-images.mjs`: migracion controlada de rutas antiguas de productos, con `dry-run`, verificacion y backup.
- `scripts/migrate-category-images.mjs`: migracion controlada de URLs antiguas de categorias, con `dry-run`, verificacion y backup.

## Siguientes fases

La carga de imagenes ya usa Supabase Storage. Las siguientes fases pueden sumar mejoras como recorte de imagen, multiples imagenes por producto o vistas publicas para consumir el catalogo.
