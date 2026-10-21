# Paso 4D: Servicios y Staff

CRUD compartido y acotado, sin modificar tablas ni politicas existentes de 4B,
Commerce, Products, Categories, Payments o Veterinaria Cueva. Se conservan los
cambios locales pendientes de 4C y 4C.1.

## Comportamiento

- Un formulario/listado para services y staff; no es un CMS ni agrega dependencias.
- UUID asignado por PostgreSQL. Los formularios no aceptan id/store_id/image_url
  arbitrarios. Todas las consultas y mutaciones se filtran por tienda y por ID.
- Nuevos registros inactivos por defecto en UI: siempre se envia is_active=false
  al crear borradores, aunque la columna tenga DEFAULT TRUE. Publicar es explicito.
- Admin ve activos/inactivos de su tienda con modulo habilitado. Super Admin puede
  gestionar el modulo deshabilitado. RLS sigue siendo la autoridad; un rechazo se
  muestra como error, nunca como guardado exitoso.
- Orden por sort_order ASC y UUID ASC; valores NULL existentes quedan al final.
  Campos opcionales vacios se normalizan a NULL. Limites conservadores de UI:
  nombre/titulo/cargo 200 caracteres, descripcion 5000, orden integer PostgreSQL.
- Se reutilizan Toggle, preparacion de imagenes con worker/limites/conversion
  WebP, hash SHA-256, slugs y patrones de formulario inline, acciones/confirmacion
  nativa y feedback de Categorias/Productos. No se cambia su CRUD.
- Al cambiar tienda/modulo se desmontan formularios, se revocan previews blob y
  se ignoran respuestas tardias. No se inicia la siguiente etapa de subida/
  vinculacion si la pagina ya fue desmontada; una solicitud enviada puede terminar.

## Imagenes

Nuevos buckets separados: service-images y staff-images. URL publica completa en
image_url; estructura de paths:

```
service-images/{store_id}-{slug}/services/{service_uuid}-{slug}/principal-{selection_uuid}.webp
staff-images/{store_id}-{slug}/staff/{staff_uuid}-{slug}/principal-{selection_uuid}.webp
```

Input JPG/PNG/WebP hasta 2 MB; se reutiliza la preparacion segura de Productos
(cabeceras antes de decodificar, worker, 4096 px/lado, 12 MP, salida hasta 2048 px)
y se comprueba tambien que el WebP resultante no supere 2 MB. Una seleccion nueva
invalida no descarta la seleccion anterior. Path UUID unico por seleccion,
upsert=false: nunca se sobrescribe. No hay credenciales privilegiadas en frontend.

La metadata se confirma antes de subir. El ID confirmado se conserva en el
formulario. Un fallo posterior permite reintentar sin otro INSERT ni UPDATE de
metadata equivalente. La copia se verifica por bytes antes de vincular su URL.
Un upload ambiguo no se repite aunque un GET devuelva 404: solo se vuelve a
verificar el mismo candidato. Una vinculacion ambigua consulta la referencia
persistida. El PATCH compara image_url original (incluido NULL), sin sobrescribir
la imagen de otra sesion, incluso si se actualizo metadata antes.

Quitar imagen guarda NULL; reemplazar conserva la anterior hasta confirmar la
nueva. Eliminar un registro NO borra objetos. Nunca se borran archivos externos,
compartidos, anteriores o candidatos huerfanos automaticamente. Si Storage no
esta configurado, se puede guardar sin imagen; si fallo una subida tras crear el
registro, quitar la seleccion y guardar conserva el mismo ID.

## SQL pendiente: revision separada

`supabase/step-4d-content-storage.sql` es un BORRADOR manual, no una migracion
aplicada. Crea solo los dos buckets y dos politicas con helper privado nuevo.
No ejecutarlo automaticamente. El frontend no lo necesita para CRUD sin imagen.

Antes de aprobarlo, ejecutar MANUALMENTE consultas de solo lectura en Supabase:

```sql
select id, name, public, file_size_limit, allowed_mime_types
from storage.buckets order by id;
select schemaname, tablename, policyname, roles, cmd, qual, with_check
from pg_policies where schemaname = 'storage' and tablename = 'objects'
order by policyname;
```

Las politicas permisivas se combinan con OR: una politica global anterior podria
invalidar el aislamiento de los buckets nuevos. La prueba local no demuestra
las politicas efectivas remotas. Revisarlas antes de aplicar, sin alterar las
politicas existentes de Commerce como parte de este paso.

El helper requiere rol/propiedad/modulo de 4B y registro real de la tabla
correspondiente. Compara IDs como texto, sin casts bigint/uuid susceptibles de
errores o desbordamiento. No usa slugs como autoridad. Solo INSERT y SELECT
autenticados para contenido administrable; no UPDATE/DELETE ni listado anonimo.
Los buckets publicos permiten leer por URL incluso imagenes de borradores o
modulos deshabilitados: no son almacenamiento privado ni apto para datos sensibles.
No se habilita listado publico de objetos.

Se comprobo sintaxis, permisos, aislamiento y reaplicacion en PostgreSQL local
aislado. Storage HTTP, limites/MIME, CORS y politicas efectivas remotas requieren
verificacion manual posterior. Bucket existente incompatible detiene el SQL en
vez de cambiarlo silenciosamente.

## Riesgos residuales

- No se agrega idempotencia SQL a las tablas nuevas. Si se pierde la respuesta de
  un INSERT, se bloquea su reenvio en ese formulario y se pide cerrar/actualizar
  la lista para recuperar el registro confirmado. Una creacion que confirme muy
  tarde aun requiere comprobacion manual antes de iniciar otra. No se promete
  exactly-once tras refresh/cierre ni se genera un ID arbitrario en el cliente.
- Archivo/operacion de imagen no se persisten entre refresh; el registro confirmado
  se recupera desde la lista. Un candidato sin vincular puede quedar huerfano.
  No se hace limpieza automatica. Los objetos originales se conservan.
- Metadata se guarda segun el patron CRUD existente (last writer wins); el CAS
  protege la referencia de imagen, no todos los campos contra edicion concurrente.
- Cambios de permisos/modulos externos se imponen en el backend. Recargar tiendas
  actualiza tambien el menu. No se introducen subscriptions ni cache de permisos.
- Si la pagina se cierra con una solicitud en curso, no es posible cancelar una
  escritura que el servidor ya haya confirmado. La respuesta no aparece en otra
  tienda; volver a consultar antes de repetir una operacion.

## Archivos

Modificados en 4D: src/App.tsx, src/types/database.ts, package.json y
tests/admin-navigation/navigation.spec.ts (el placeholder ahora hace un GET real).
Nuevos: src/features/content/ContentPage.tsx, contentForm.ts;
src/services/moduleContent.ts, moduleImages.ts;
scripts/module-content.unit.test.mjs, module-content-storage.sql.test.mjs;
tests/admin-navigation/content.spec.ts; step-4d-content-storage.sql y este documento.

## Pruebas locales

```
npm run test:content:unit
npm run test:content:browser
npm run test:content:sql
npm run test:stores:browser
npm run test:stores:sql
npm run test:products:creation:unit
npm run test:products:images:unit
npm run test:products:images:browser
npx tsc -p tests/admin-navigation/tsconfig.json
npm run build
npm run lint
git diff --check
```

Browser ejecuta el SDK real con Supabase HTTP simulado en loopback, bloqueando
hosts externos y sin cargar .env. El runner SQL reutiliza fixtures 4B en un cluster
PostgreSQL desechable, sin conexion remota. Las capturas quedan en test-results
(ignorado). Ningun archivo binario de prueba se incluye en Git.
