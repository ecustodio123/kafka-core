# Paso 4C: tiendas y navegacion

Implementacion frontend sobre las politicas del Paso 4B. No requiere SQL nuevo.

- Auth verifica el usuario mediante `getUser()`. Solo `app_metadata.global_role`
  informa el rol visual. Sin clave de rol, un propietario existente conserva
  el rol Admin; valores explicitos desconocidos no obtienen este fallback.
- Super Admin lista tiendas autorizadas por RLS; Admin filtra ademas por
  `owner_user_id`. La tienda seleccionada se mantiene durante la navegacion
  y renovaciones de sesion del mismo usuario, no despues de recargar la pagina.
- El cambio de tienda desmonta formularios, datos y configuracion anteriores.
  Las respuestas tardias de configuracion y tiendas se descartan.
- Falta de configuracion significa flags deshabilitados. Solo el propietario
  conserva acceso de compatibilidad al catalogo antiguo, con aviso explicito.
  Una configuracion existente con Commerce deshabilitado no tiene esta excepcion.
  Un error de lectura nunca se interpreta como configuracion ausente.
- Super Admin no obtiene acceso al catalogo de otra tienda. Servicios y Staff
  son placeholders; aun no consultan ni modifican su contenido.
- Admin consulta flags sin controles editables. Solo Super Admin puede guardar
  explicitamente. La actualizacion compara los tres valores anteriores; una
  creacion utiliza INSERT, no upsert. Conflictos o errores requieren recarga.
  El doble envio se bloquea inmediatamente. No se eliminan datos de modulos.

## Autoridad de seguridad

La interfaz no reemplaza RLS. Las politicas de Commerce y sus RPC siguen
basadas en propietario y NO se modifican: ocultar su menu no revoca acceso
directo al catalogo. Servicios/Staff y store_features utilizan la autorizacion
real del Paso 4B, que comprueba rol/propietario/modulo en PostgreSQL.
Los roles y flags mostrados son un snapshot; recargar tiendas/configuracion
actualiza la interfaz despues de cambios administrativos externos.
No se permiten asignaciones de roles desde el navegador.

## Validacion local

```
npm run test:stores:unit
npm run test:stores:sql
npm run test:stores:browser
npx tsc -p tests/admin-navigation/tsconfig.json
npm run test:products:creation:unit
npm run test:products:images:unit
npm run test:products:images:browser
npm run build
npm run lint
git diff --check
```

Los tests browser usan Supabase simulado en loopback, bloquean hosts externos
y nunca cargan .env. El runner SQL ejecuta un cluster PostgreSQL desechable.
Las capturas quedan en test-results (ignorado por Git).

Pendiente 4D: CRUD de Servicios/Staff sobre sus RLS existentes. Sin cambios en
Payments, Storage, Commerce, infraestructura o roles adicionales.

## Archivos de esta entrega

Modificados: `src/App.tsx`, `src/services/stores.ts`, `src/types/database.ts`,
`src/features/products/ProductsPage.tsx`,
`src/features/categories/CategoriesPage.tsx` y `package.json`.
En Productos/Categorias solamente se sustituye el Toggle local por el compartido.

Nuevos: `src/components/Toggle.tsx`, `src/features/stores/storeAccess.ts`,
`src/services/storeFeatures.ts`, `src/hooks/useStoreFeatures.ts`,
`scripts/store-navigation.unit.test.mjs`, este documento y los cinco archivos
de `tests/admin-navigation/` (HTML, harness, spec, config Playwright y tsconfig).
