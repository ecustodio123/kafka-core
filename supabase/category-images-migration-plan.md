# Plan de migracion para imagenes antiguas de categorias

## Estado actual

`categories.image_url` guarda URLs publicas completas. Por eso las imagenes existentes seguiran funcionando mientras la URL siga apuntando a un objeto valido en Supabase Storage.

Las nuevas imagenes se suben al bucket `category-images` con este formato:

```text
{store_id}-{store_slug}/categories/{category_id}-{category_slug}/principal-{timestamp}.webp
```

Ejemplo:

```text
1-veterinaria-kafka/categories/3-juguetes/principal-1791500000000.webp
```

## No ejecutar migracion automatica aun

No se deben mover archivos ni actualizar `categories.image_url` sin una ventana controlada. La migracion debe hacerse con respaldo y verificacion.

## Procedimiento seguro propuesto

1. Exportar respaldo de categorias con imagen:

```sql
select id, store_id, name, slug, image_url
from public.categories
where image_url is not null;
```

2. Identificar URLs que apuntan al bucket `category-images` y extraer su path actual.

3. Para cada categoria:

- Leer `stores.slug`.
- Generar `store_folder = {store_id}-{store_slug}`.
- Usar el `categories.id` real, no inferirlo desde carpetas existentes.
- Generar `category_folder = {category_id}-{slug(category.slug)}`.
- Copiar el archivo a:

```text
{store_folder}/categories/{category_folder}/principal-migrated.webp
```

4. Subir con `upsert: false` para no sobrescribir.

5. Verificar que la nueva URL publica renderiza correctamente.

6. Actualizar `categories.image_url` a la nueva URL solo despues de confirmar la copia.

7. Mantener los archivos antiguos durante una ventana de rollback.

## Rollback

Restaurar `categories.image_url` desde el respaldo del paso 1. No borrar objetos antiguos hasta confirmar que Kafka Admin y Kafka Commerce leen correctamente las nuevas rutas.
