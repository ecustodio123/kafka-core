# Publications V1: revision y activacion manual

## Estado y alcance

Implementacion local, sin SQL remoto, despliegues, cambios de roles ni habilitaciones.
Reutiliza Auth, selector de tienda, dos roles y `kafka_modules` del Paso 4B.
No modifica Payments, Commerce, productos, categorias, Servicios o Staff.

El usuario confirma que existen `public.publications` (columnas del requerimiento),
`publication_type IN ('pdf','article')` y el bucket privado `publication-files`, PDF
de hasta 10 MB. Tambien proporciono la definicion real de
`trg_publications_updated_at`: BEFORE UPDATE FOR EACH ROW, funcion
`public.set_publications_updated_at()`, PL/pgSQL, `search_path=''`, cuerpo
`BEGIN NEW.updated_at = NOW(); RETURN NEW; END;`, sin SECURITY DEFINER.
No recibimos todavia las definiciones completas de constraints/defaults, RLS o ACL
remotos; no se asume que la fixture sea su copia exacta.
La migracion no recrea la tabla/bucket. La prueba PostgreSQL usa una fixture local,
no una copia certificada del esquema remoto.

## Preflight obligatorio, solo lectura

Primero ejecutar manualmente **todo `publications-v1-preflight.sql`** en SQL Editor
y compartir la unica columna JSON `publication_preflight`. Es solo SELECT y agrupa
constraints, defaults, funciones de triggers, RLS, ACL, helpers y bucket. La consulta
de triggers sola no incluye la informacion necesaria para revisar los permisos.

Consultas individuales equivalentes para inspeccion:

```sql
select column_name,data_type,is_nullable,column_default
from information_schema.columns
where table_schema='public' and table_name in ('publications','store_features')
order by table_name,ordinal_position;

select conname,convalidated,pg_get_constraintdef(oid)
from pg_constraint where conrelid='public.publications'::regclass;
select indexname,indexdef from pg_indexes
where schemaname='public' and tablename='publications';
select tgname,pg_get_triggerdef(oid),pg_get_functiondef(tgfoid) from pg_trigger
where tgrelid='public.publications'::regclass and not tgisinternal;

select status,publication_type,count(*) from public.publications
group by status,publication_type;
select store_id,slug,count(*) from public.publications
group by store_id,slug having count(*)>1;

select id,public,file_size_limit,allowed_mime_types from storage.buckets
where id='publication-files';
select schemaname,tablename,policyname,permissive,roles,cmd,qual,with_check
from pg_policies where (schemaname='storage' and tablename='objects')
or (schemaname='public' and tablename in ('publications','store_features'));
select grantee,privilege_type from information_schema.role_table_grants
where table_schema='public' and table_name='publications';
select grantee,column_name,privilege_type from information_schema.column_privileges
where table_schema='public' and table_name='publications';
select pg_get_functiondef('kafka_modules.global_role()'::regprocedure),
pg_get_functiondef('kafka_modules.module_enabled(bigint,text)'::regprocedure),
pg_get_functiondef('kafka_modules.can_manage(bigint,text)'::regprocedure);
```

Contrato destino: `publication_type IN ('document','article')`, manteniendo el
frontend preparado. `document` describe el registro documental; PDF sigue siendo
el unico formato de archivo V1. No es un requisito de Supabase: se mantiene para
evitar dos contratos locales diferentes. Esta migracion autoriza explicitamente
el cambio semantico `pdf -> document`; `article` permanece intacto.

El preflight SQL reconoce CHECK sencillos IN/ANY/OR que limitan exclusivamente
`publication_type` a pdf/article o document/article, independientemente de su nombre.
Un CHECK mas complejo, FK, regla, politica o vista dependiente de `pdf` requiere
revision: se aborta sin quitar restricciones desconocidas ni modificar otros modulos.
Verificar tambien `status IN ('draft','published','archived')`, nullability/defaults,
datos fuera de limites y consumidores externos del literal `pdf`. Estos no se
reescriben automaticamente.

## SQL propuesto

Archivo: `migrations/202610260001_publications_v1.sql`.

- Aplicar solo despues del preflight, respaldo de tabla/DDL/ACL/politicas y revision.
- Ejecutar el archivo completo manualmente como `postgres`/BYPASSRLS. Es transaccional
  y reaplicable. Conflictos desconocidos de esquema, bucket, datos o slug abortan.
- Bloquea Publicaciones con ACCESS EXCLUSIVE y `lock_timeout=5s`. Aplicar en una
  ventana breve sin escrituras concurrentes; el indice y VALIDATE pueden bloquear.
- Antes de convertir, verifica la firma, evento y cuerpo exacto del trigger antiguo.
  Retira solo `trg_publications_updated_at` y el trigger propio si es reaplicacion;
  conserva sin cambios `public.set_publications_updated_at()` para otros usos.
- Retira SOLO CHECK de tipo reconocidos, sin CASCADE. Convierte exclusivamente las
  filas `publication_type='pdf'` y el default literal `pdf`, si existe. No cambia
  article ni los defaults article/document/ausente. No toca IDs, tenants, slugs,
  contenido, paths, nombres, tamanos ni timestamps historicos durante la conversion.
- Instala una unica validacion `kafka_publications_validate`, que tambien gestiona
  updated_at en futuras escrituras. No quedan dos triggers de timestamp ejecutandose.
- Agrega `publications_enabled` con default false si falta; conserva valores existentes.
- Extiende solamente las allowlists de `module_enabled` y `can_manage`; mantiene
  compatibilidad de roles y comportamiento Servicios/Staff. Revisar las definiciones
  remotas para no sobrescribir ajustes externos que no esten versionados.
- Conserva las politicas permisivas de `store_features` del 4B y agrega guardas
  restrictivas de escritura; solo Super Admin puede cambiar flags.
- Endurece permisos de Publicaciones con allowlist de columnas y guardas restrictivas
  contra politicas permisivas preexistentes. No borra esas politicas historicas.
- Agrega unicidad `(store_id,slug)`, validacion de campos y trigger de timestamps,
  autor y referencia PDF. La unica actualizacion de filas existentes es pdf->document.
- La lectura anonima entrega solo metadata publicada si el modulo esta habilitado.
  No concede acceso anonimo a la ruta privada, autor, objetos ni contenido documental.
- Storage conserva el bucket privado y su configuracion. Las guardas nuevas solo
  restringen `publication-files`, incluso ante politicas antiguas `USING(true)`.
- Subir/leer requiere un registro real, misma tienda y permiso de modulo. Sin
  UPDATE, sobrescritura, DELETE ni listado anonimo de PDF.

No publicar el frontend antes de aplicar/verificar la extension del flag: el SELECT
de `store_features` ahora requiere `publications_enabled`. Si falta, los modulos
mostraran error de configuracion, no permisos ficticios.

## Flujo y recuperacion

1. Validar formulario y PDF antes de escribir: MIME `application/pdf`, extension,
   cabecera `%PDF-`, 1 byte a 10 MB, nombre limitado. No es antivirus ni parser completo.
2. Crear primero un borrador con UUID estable durante el intento del formulario.
   INSERT/lectura de recuperacion conserva el mismo UUID ante respuesta perdida.
   La unicidad de slug se garantiza en PostgreSQL, no mediante un SELECT previo.
3. Obtener/conservar el registro confirmado antes de subir. Ruta:
   `{store_id}-{store_slug}/publications/{publication_uuid}-{publication_slug}/documento-{uuid}.pdf`.
   Usa el slug compartido y `upsert:false`; no usa el nombre original como identidad.
4. Verificar los bytes descargados por SHA-256 y tamano antes de vincular PDF/nombre/
   tamano en un solo UPDATE condicionado por la referencia anterior, incluido NULL.
5. Publicar despues de vincular. Un documento no puede publicarse sin referencia
   PDF existente. PostgreSQL conserva `published_at` al editar, archivar o republicar.
6. Los reintentos de subida ambigua solo verifican el MISMO candidato: ni 404 ni
   timeout permiten re-subir automaticamente. El ID del borrador permanece disponible.
7. Eliminacion requiere confirmacion y DELETE con fila retornada; cero filas o errores
   no muestran exito. No se eliminan archivos al borrar el registro.

No hay transaccion distribuida entre Storage y PostgreSQL. Un fallo de enlace puede
dejar un archivo sin referencia. Se conserva para recuperacion; no hay limpiezas masivas.
Los PDF anteriores se conservan al reemplazar o borrar: no se puede demostrar
exclusividad global desde el navegador. **Limpieza automatica no implementada**;
requiere un mecanismo backend coordinado revisado por separado antes de permitirla.
No conceder DELETE amplio al navegador para resolverlo.

El formulario de Publicaciones no persiste archivos ni credenciales en el navegador.
Tras refresh se debe abrir el borrador existente de la lista; volver a seleccionar
un archivo genera otra seleccion explicita, no reintenta automaticamente una subida
anterior. Antes de crear otro registro tras un fallo, recargar y comprobar la lista.

## PDF privados y consumo publico

`signedPublicationPdf(storeId, publicationId)` relee un registro autorizado, valida
pertenencia de ruta y firma por 60 segundos. No admite rutas arbitrarias como entrada.
El enlace en memoria se retira a los 55 segundos; no se guarda ni registra en logs.
Una URL ya emitida puede seguir funcionando hasta expirar, aun tras deshabilitar el
modulo o revocar acceso. No hay endpoint publico de firma ni iframe de PDF.

`listPublishedPublications(storeId, offset, limit)` consulta metadata con RLS y pagina
de 1 a 100 filas (default 50), orden display_order, published_at descendente, UUID.
Utiliza el cliente/identidad actual. Los consumidores publicos deben usar su cliente
anon normal; no sirve para eludir RLS ni firmar archivos. No se modifico Kafka Commerce
ni se construyo una pagina para un cliente. Descarga publica autorizada queda pendiente.

Articulo admite metadata/resumen y conserva `content` existente: sin editor ni CMS.
`cover_storage_path` se conserva pero no hay un nuevo flujo de portadas.

## Verificacion manual posterior (sin ejecutarla desde esta tarea)

1. Verificar permisos, esquema/politicas y UI con flags false; mantener pagos OFF.
2. Habilitar Publicaciones solo en tienda dedicada de prueba como Super Admin.
3. Admin propietario: crear borrador, subir PDF, publicar, editar, archivar,
   reemplazar y abrir enlace privado. Confirmar fecha y rutas sin sobrescritura.
4. Probar otro usuario/tienda, flag false y anon: no escrituras ni PDF privados.
5. Confirmar metadata publica solo para published + modulo true; pagina siguiente.
6. Ante fallo, deshabilitar publications_enabled de esa tienda desde contexto
   confiable. Conservar registros/archivos; no revertir permisos con politicas amplias.

## Activacion paso a paso para probar local contra la base real

1. Ejecutar `publications-v1-preflight.sql` y revisar sus resultados completos. No
   aplicar mientras falten las definiciones efectivas de constraints/ACL/politicas
   o si los helpers remotos contienen diferencias no versionadas de Servicios/Staff.
2. Respaldar tabla Publicaciones, DDL (constraints/defaults/triggers), funciones
   implicadas, politicas y grants. Guardar fuera del repo, sin exportar credenciales.
   Registrar cantidades por tipo/estado e IDs de las filas pdf para comparar.
3. Tras aprobar el preflight, aplicar MANUALMENTE el archivo completo
   `migrations/202610260001_publications_v1.sql` como postgres. No ejecutarlo por partes.
   La notificacion indica cuantas filas pdf se convirtieron. Ante cualquier error,
   ROLLBACK de la transaccion; no continuar con statements sueltos.
4. Solo SELECT: comparar respaldo y filas actuales, excluyendo unicamente el tipo
   convertido. Verificar cero `pdf`, misma cantidad total y de article, fechas y
   referencias intactas; default document si antes era pdf; constraint validado;
   un solo trigger propio y funcion antigua conservada; RLS/ACL y bucket privado.
5. Confirmar que Servicios/Staff/Commerce siguen como antes. No habilitar flags
   de clientes para probar. Como Super Admin, habilitar Publicaciones exclusivamente
   en una tienda de pruebas autorizada mediante Modulos.
6. Usar el `.env` local existente con URL y llave PUBLICA del proyecto real. Nunca
   service_role. Iniciar `npm run dev -- --host 127.0.0.1 --port 5174 --strictPort`
   (si esta ocupado, elegir otro puerto permitido por Auth). No hacer push/deploy.
7. Como Admin propietario: crear borrador, subir PDF de prueba pequeno, publicar,
   editar, archivar, reemplazar y abrir la URL privada. Estas acciones manuales SI
   escribiran registros/archivos de la tienda de pruebas; no usar datos de clientes.
8. Al terminar, deshabilitar Publicaciones de esa tienda si procede. No eliminar
   archivos historicos ni ampliar permisos para intentar resolver fallos.

Fallo antes de COMMIT: PostgreSQL revierte tambien la conversion, defaults, CHECK,
triggers y permisos. Fallo despues de COMMIT: deshabilitar el modulo y detener el
servidor local. No restaurar ciegamente el CHECK antiguo mientras haya document;
una reversion de contrato necesita SQL revisado y el respaldo, considerando las
publicaciones creadas/editadas despues. No se incluye una reversion destructiva.

## Pruebas locales

```sh
npm run test:publications:unit
npm run test:publications:sql
npm run test:publications:browser
npm run test:stores:unit
npx tsc -p tests/admin-navigation/tsconfig.json
npm run build
npm run lint
git diff --check
```

PostgreSQL usa un cluster temporal sin TCP y fixtures locales; falla si no esta
disponible, no omite las pruebas. Playwright usa el SDK real con HTTP local simulado
y bloquea solicitudes externas. Eso no certifica las politicas ni Storage remotos.
