# Kafka Admin

Panel administrativo reutilizable para Kafka Core. Esta iteracion implementa React conectado a Supabase, CRUD inicial de productos, Auth basico para resolver la tienda del usuario y subida de imagenes con Supabase Storage.

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

5. Crea un usuario desde Supabase Auth. Kafka Admin no permite registro publico.

6. Asocia ese usuario a una tienda:

```sql
update public.stores
set owner_user_id = 'USER_ID_DE_AUTH'
where id = 1;
```

7. Ejecuta el proyecto:

```bash
npm run dev
```

## Scripts

```bash
npm run dev
npm run lint
npm run build
npm run preview
```

## Productos

La pantalla de productos permite:

- leer productos filtrados por la tienda asociada al usuario autenticado
- crear productos asociados automaticamente a esa tienda
- editar nombre, descripcion, precio, disponibilidad y estado activo
- subir una imagen por producto a Supabase Storage
- alternar Disponible/Agotado usando `available`
- desactivar/reactivar productos usando `active`

No hay eliminacion fisica en esta fase.

## Arquitectura

- `src/lib/supabase.ts`: instancia centralizada del cliente de Supabase.
- `src/services/products.ts`: capa de acceso a datos para productos.
- `src/services/productImages.ts`: subida y resolucion de URLs publicas de imagenes.
- `src/services/stores.ts`: resolucion de tienda desde el usuario autenticado.
- `src/features/auth/AuthPage.tsx`: login con Supabase Auth.
- `src/features/products/ProductsPage.tsx`: UI y flujo CRUD de productos.
- `src/types/database.ts`: tipos minimos para las tablas usadas.
- `supabase/phase-6-auth-rls.sql`: SQL para Auth/RLS de esta fase.
- `supabase/phase-7-storage.sql`: SQL para Storage e imagenes de producto.

## Siguientes fases

La carga de imagenes ya usa Supabase Storage. Las siguientes fases pueden sumar mejoras como recorte de imagen, multiples imagenes por producto o vistas publicas para consumir el catalogo.
