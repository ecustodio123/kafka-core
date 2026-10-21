# Paso 4C.1: aceptar invitaciones y crear contrasena

Sin SQL, roles nuevos, invitaciones publicas ni privilegios adicionales.
El envio sigue realizandose desde Supabase Dashboard.

## Contrato soportado

El cliente instalado usa el flujo implicit de supabase-js. El Dashboard verifica
el enlace en Auth y redirige al Site URL (o redirect autorizado), con credenciales
en el fragmento y `type=invite`. El SDK verifica y persiste su sesion habitual.
Antes de inicializarlo capturamos el contexto del retorno; su detector limpia la
URL mediante replaceState una vez capturados los parametros. No intercambiamos
tokens por segunda vez ni tratamos SIGNED_IN como prueba de invitacion.

El guard de invitacion se evalua ANTES del guard que monta el panel. Se exige:

- Coincidencia entre el token del retorno y la sesion obtenida por el SDK.
- Usuario comprobado por `auth.getUser(access_token)`, con invited_at y correo
  confirmado; identidad coincidente con la sesion.
- Claims del MISMO token validado: sub/session_id y metodo OTP o invite. Auth
  emite OTP en el flujo implicit; no existe evento INVITED ni claim exclusivo
  de invitacion para este flujo. Una sesion de password sola no basta.
- Para recuperar un flujo pendiente: mismo usuario y misma sesion Auth.

El marcador local `kafka-admin:pending-invite` solo contiene userId/sessionId,
NO contrasenas ni tokens. Mantiene el guard tras refresh/cierre/nueva pestana,
si el almacenamiento esta disponible. No concede autorizacion: se revalida
Auth antes del formulario y antes de updateUser. No copiamos las credenciales
persistidas por el SDK a otro almacenamiento. Un cambio/cierre de sesion retira
el formulario; errores externos no se reflejan literalmente ni se registran.

Tras confirmar `auth.updateUser({ password })`, se eliminan campos y marcador,
se muestra exito y solo el boton Continuar monta el panel. Si se recarga despues
del exito, la URL ya es `/` y no se solicita otra contrasena.

Esto es un guard de UX, no una nueva frontera RLS. Supabase entrega una sesion
autenticada al aceptar el enlace, antes de crear la contrasena. El tipo del URL
y el marcador no son pruebas privilegiadas de autorizacion; los usuarios Auth
autenticados ya pueden cambiar su propia contrasena. La pertenencia a tiendas
y las politicas existentes siguen siendo la autoridad. No se exige completar
onboarding en PostgreSQL ni se pretende impedir accesos directos a sus APIs.

## Configuracion manual pendiente

No se consultaron ni modificaron dashboards remotos. Revisar en Auth > URL
Configuration:

- Site URL: `https://kafka-core.pages.dev`
- Redirect URLs exactas permitidas:
  - `https://kafka-core.pages.dev/`
  - `https://kafka-core.pages.dev/auth/accept-invite`
  - `http://127.0.0.1:5174/`
  - `http://127.0.0.1:5174/auth/accept-invite`

Mantener la plantilla de invitacion estandar con ConfirmationURL. Si el Dashboard
no ofrece redirect por invitacion, se utiliza Site URL, no el localhost desde
donde el operador abrio el Dashboard. No cambiar Site URL de produccion solo
para probar localmente: usar un proyecto de pruebas o la opcion de redirect
del contexto administrativo confiable, si esta disponible.

Verificar que Pages sirva la SPA en `/auth/accept-invite` (sin un 404 personalizado
que anule el fallback). La prueba local cubre acceso directo y retorno a `/`.
La politica referrer del HTML evita reenviar parametros como Referer.

## Prueba real manual (no realizada)

1. Invitar un correo controlado desde Dashboard y abrir el enlace en una ventana
   privada, evitando sustituir la sesion de Super Admin del mismo navegador.
2. Confirmar que se muestra crear contrasena y no se solicitan tiendas antes de
   completarla. URL limpia; refresh conserva la pantalla, sin guardar campos.
3. Probar confirmacion distinta, politica real de contrasenas y guardado exitoso.
4. Continuar: un admin sin tienda muestra estado sin asignacion, no obtiene una
   tienda ni un rol por aceptar el enlace. Con tienda, se aplican las RLS de 4B.
5. Cerrar sesion e ingresar por email/password; comprobar Super Admin por separado.
6. Probar un enlace expirado/reutilizado y acceso directo sin sesion.

Templates personalizadas con token_hash o PKCE no se implementan en este paso:
fallan cerradas y sin inventar un code_verifier. El SDK/documentacion no soportan
PKCE para inviteUserByEmail entre navegadores diferentes. Password recovery,
envio de invitaciones, SMTP y configuracion remota siguen fuera de alcance.
La politica de contrasenas de Supabase puede exigir mas que el minimo local
de 8 caracteres. Una respuesta de guardado perdida no se declara exito: se
mantiene el flujo y puede requerirse reintentar con una contrasena diferente.
Sin almacenamiento local disponible, el path dedicado conserva el guard al
recargar, pero no se garantiza recuperar el marcador desde otras rutas/pestanas.

## Validacion aislada

### Escritura ligada a la invitacion (correccion P1)

El cliente Auth principal no escribe la contrasena. Se copia la sesion antes de
validarla con getUser(bearer explicito) y se comprueban identidad, session_id,
origen OTP/invite y expiracion. Cada escritura usa un AuthClient privado con
persistSession=false, autoRefreshToken=false y detectSessionInUrl=false: solo
memoria, sin localStorage ni BroadcastChannel, y se destruye al terminar.

Su transporte permite exclusivamente GET/PUT a /auth/v1/user con el bearer
original verificado. No permite refresh HTTP ni fallback a la cuenta global.
Antes de enviar el PUT se vuelve a comprobar la sesion principal (incluido el
token exacto). Un cambio detectado de cuenta, logout o refresh cancela el envio;
se puede reintentar explicitamente tras validar nuevamente la invitacion.
Una sesion expirada/rechazada no autoriza escrituras. Solo un guardado por flujo
puede estar en curso, tambien cuando se invoca sin pasar por el formulario.

Cambiar de cuenta despues de la ultima comprobacion no puede redirigir el PUT:
el bearer sigue siendo el de la invitacion. Logout no puede garantizar cancelar
una solicitud ya autorizada/enviada; la validez final del JWT la decide Supabase.
No se promete exclusion entre dos navegadores independientes aceptando la misma
invitacion. No se almacenan passwords ni tokens adicionales de forma persistente.
Una respuesta perdida o incompleta no se declara exitosa ni se reenvia sola.

Las regresiones usan el SDK real con transporte HTTP en memoria. Un control con
la escritura global anterior reproduce el cambio de contrasena de la cuenta B;
con el escritor aislado se cancela antes del PUT o se escribe exclusivamente A,
incluso cambiando la cuenta justo despues de la ultima comprobacion. Tambien se
prueban logout, refresh, expiracion, revocacion, concurrencia y errores de red.

```
npm run test:auth:invite:unit
npm run test:auth:invite:browser
npm run test:stores:browser
npx tsc -p tests/admin-navigation/tsconfig.json
npm run build
npm run lint
git diff --check
```

Browser usa el SDK instalado, Auth HTTP simulado en loopback y bloquea destinos
externos. Credenciales y passwords de fixtures son ficticios. No se cargan .env
ni se contacta Supabase real. Capturas solo de formularios vacios en test-results.

## Archivos de 4C.1

Modificados: `src/App.tsx`, `src/lib/supabase.ts`,
`src/features/auth/AuthPage.tsx`, `index.html`, `package.json`.
Nuevos: `src/features/auth/AcceptInvitePage.tsx`,
`src/features/auth/AuthLayout.tsx`, `src/features/auth/inviteFlow.ts`,
`scripts/auth-invite.unit.test.mjs`,
`tests/admin-navigation/auth-invite.spec.ts` y este documento.
Los cambios locales de 4C anteriores se conservan intactos salvo la integracion
del guard y el estado claro de usuario sin tienda en App, y comandos en package.

## Fuentes oficiales

- https://supabase.com/docs/reference/javascript/auth-admin-inviteuserbyemail
- https://supabase.com/docs/guides/auth/redirect-urls
- https://supabase.com/docs/reference/javascript/auth-updateuser
- https://github.com/supabase/auth/blob/master/internal/api/verify.go

Se contrasto tambien GoTrueClient.ts del auth-js instalado: inicializacion,
detector del retorno, emision SIGNED_IN/PASSWORD_RECOVERY y limpieza del fragmento.
