# Plan de migracion para imagenes antiguas de productos

## Estado actual

Las imagenes nuevas se suben al bucket `product-images` con este formato:

```text
{store_id}-{store_slug}/products/{product_id}-{product_slug}/principal-{timestamp}.webp
```

Ejemplo:

```text
1-veterinaria-kafka/products/10-alimento-premium/principal-1791500000000.webp
```

Las imagenes antiguas con formato numerico siguen funcionando porque `products.image_path` guarda el path relativo y la app sigue resolviendo cualquier path mediante `getPublicUrl`.

Formato antiguo:

```text
{store_id}/{product_id}/image.webp
```

## No ejecutar migracion automatica aun

No se deben mover archivos ni actualizar registros historicos sin una ventana controlada. La migracion debe hacerse con respaldo y verificacion.

## Script preparado

Se agrego un script local:

```text
scripts/migrate-product-images.mjs
```

Requiere variables de entorno, sin guardarlas en el repositorio:

```bash
export SUPABASE_URL="https://..."
export SUPABASE_SERVICE_ROLE_KEY="..."
```

Tambien acepta `VITE_SUPABASE_URL` como fallback para la URL. La service role key es necesaria porque es una migracion administrativa local; nunca debe usarse en Kafka Admin ni en el navegador.

### Simulacion completa con CSV

```bash
npm run migrate:product-images -- \
  --mode dry-run \
  --csv /ruta/al/reporte.csv
```

### Simulacion de un solo producto

```bash
npm run migrate:product-images -- \
  --mode dry-run \
  --csv /ruta/al/reporte.csv \
  --product-id 1
```

### Ejecutar un solo producto como prueba controlada

```bash
npm run migrate:product-images -- \
  --mode execute \
  --csv /ruta/al/reporte.csv \
  --product-id 1
```

El modo por defecto es `dry-run`.

El script:

- conserva los archivos originales
- usa `upsert: false` para no sobrescribir destinos
- verifica la copia descargando origen y destino y comparando bytes
- actualiza `products.image_path` solo si sigue igual que en el CSV
- genera backup local JSONL de las rutas originales en `migration-backups/`
- se puede reanudar: si un registro ya cambio o el destino existe, lo omite

## Procedimiento seguro propuesto

1. Exportar un respaldo de `public.products` con al menos:

```sql
select id, store_id, name, image_path
from public.products
where image_path is not null;
```

2. Listar objetos actuales del bucket `product-images` desde Supabase Storage.

3. Identificar registros con estructura antigua:

```sql
select id, store_id, name, image_path
from public.products
where image_path ~ '^[0-9]+/[0-9]+/';
```

4. Para cada producto:

- Leer `stores.slug`.
- Generar `store_folder = {store_id}-{store_slug}`.
- Generar `product_folder = {product_id}-{slug(product.name)}`.
- Copiar el archivo antiguo a:

```text
{store_folder}/products/{product_folder}/principal-migrated.webp
```

5. Verificar que la nueva URL publica renderiza correctamente.

6. Actualizar `products.image_path` al nuevo path solo despues de confirmar la copia.

7. Mantener el archivo antiguo durante una ventana de rollback.

8. Si algo falla, restaurar `products.image_path` desde el respaldo y conservar los objetos antiguos.

## Rollback

El rollback consiste en restaurar `products.image_path` desde el respaldo tomado en el paso 1. No se recomienda borrar objetos antiguos hasta confirmar que Kafka Admin y Kafka Commerce leen correctamente las nuevas rutas.
