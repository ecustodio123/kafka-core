# Kafka Payments: cierre documental de fase 3D

Fecha: 2026-10-16. Alcance: Kafka Core/Admin y contratos observados de Kafka
Commerce. Este documento registra el estado conocido; no habilita pagos ni
autoriza despliegues. No equivale a una certificacion del entorno remoto.

## Procedencia y estado general

- **Repositorio:** hechos comprobables en el codigo local y sus migraciones.
- **Usuario:** operaciones remotas y resultados comunicados por el propietario;
  no fueron comprobados mediante acceso remoto en esta revision.
- **Pendiente remoto:** requiere una verificacion operativa independiente.

**Usuario:** migraciones de pagos 001-016 aplicadas manualmente en Supabase;
016 aplicada con permisos verificados. Pagos publicos deshabilitados y handlers
de pago no desplegados. Las credenciales Culqi TEST se registraron por tienda
en Vault; su vigencia actual no se comprobo remotamente.

**Repositorio:** el hardening backend esta implementado. La integracion completa
de Commerce y la confirmacion financiera automatizada siguen pendientes. Puede
continuarse con UI manteniendo intactos los contratos y las barreras de pagos.
No declarar el checkout online listo para clientes.

## Funciones y despliegue conocido

Todas las funciones siguientes existen localmente en `supabase/functions/`.

| Funcion | Implementacion local | Estado remoto conocido |
| --- | --- | --- |
| `create-order` | Orden atomica, precios del servidor, idempotencia y sesion para online; WhatsApp independiente | Usuario confirmo despliegue y pruebas de una version anterior. La version local con sesiones no se ha confirmado desplegada. |
| `get-payment-config` | Configuracion publica TEST, sin secretos ni IDs de Vault | Usuario confirmo despliegue y pruebas; revision exacta desplegada pendiente. |
| `create-payment-attempt` | MOCK privado y ruta Culqi TEST con autorizacion/claim atomicos y evidencia conservadora | No desplegada, segun usuario. |
| `complete-payment-3ds` | Continuacion TEST con source/device originales y claim autorizado exclusivo | No desplegada, segun usuario. |
| `get-order-payment-status` | Consulta minima mediante token de sesion y aislamiento por tienda/orden | No hay confirmacion de despliegue. |
| `reconcile-payment-attempt` | Diagnostico administrativo, solo GET de cargo, sin escritura financiera | No desplegada en el estado comunicado; flag deshabilitado por defecto. |

`supabase/config.toml` configura `verify_jwt=false`. No sustituye la autorizacion:
el checkout usa sesiones de pago verificadas por backend y el diagnostico valida
Supabase Auth y propiedad de tienda. Confirmar las versiones efectivamente
desplegadas antes de conectar consumidores nuevos.

## Garantias verificadas en repositorio

- Creacion online y emision inicial de sesion son atomicas en PostgreSQL. El token
  usa 32 bytes aleatorios; solo se persiste SHA-256. Expiracion inicial: 15 minutos.
  Un replay idempotente no recupera ni emite nuevamente el token.
- Reserva valida identidad/idempotencia, tienda, orden, source, monto y moneda.
  Los importes provienen de productos/orden persistidos, no del navegador.
- Las RPC de 016 autorizan sesion y adquieren claim en la misma transaccion:
  locks `orders -> payment_attempts -> order_payment_sessions`, expiracion mediante
  `clock_timestamp()` despues de bloquear, sesion active y no revocada.
- Las rutas reales requieren literalmente `authorized === true` y
  `acquired === true` antes del POST. Un solo ejecutor adquiere cada etapa.
  Un intento created puede recuperarse, pero no un processing, terminal o con
  reconciliacion pendiente. No se liberan claims por timeout.
- Las huellas vinculan source e idempotencia; 3DS exige el device original.
  No se persisten tokens de tarjeta ni datos `authentication_3DS` para recuperarlos.
- Revocacion incluye sesiones expired dentro de la ventana de recuperacion.
  Esa ventana, hasta 24 horas desde crear la sesion, permite solo estado minimo:
  no renueva sesiones, no autoriza claims ni nuevos cargos.
- Revocar antes del claim impide adquirirlo. Revocar despues de un claim confirmado
  no cancela necesariamente el POST autorizado o ya iniciado.
- Credenciales privadas se obtienen en backend mediante RPC de Vault por tienda,
  sin aceptar secret_id del cliente. RPC de servicio restringidas a service_role;
  el helper interno de 016 no es ejecutable directamente por ese rol.
- `already_paid` anticipado en 3DS responde genericamente, sin detalles financieros.
  El endpoint de estado es la via autorizada para consultar estados minimos.
- MOCK exige secreto privado del runner, tienda dedicada y marcadores de prueba.
  Puede simular paid; no debe habilitarse para pedidos comerciales.

Referencias: migraciones 009-010, 015-016 y
[contrato de claims 016](payment-session-claim-016.md). Los documentos historicos
que indiquen "local only" describen su momento de implementacion; el estado de
aplicacion remota comunicado actualmente es el registrado arriba.

## Incertidumbre y limites financieros

**Repositorio:** ambos callers reales usan `culqi-test-evidence` para HTTP 200.
`canFinalizePaid` permanece siempre false y no es un flag configurable. No hay
rama real de exito que finalice paid. HTTP 201 solo habilita requires_3ds cuando
la identidad resulta compatible; datos insuficientes o contradictorios conservan
processing e incertidumbre. Un HTTP exitoso no acredita captura ni autenticacion.

Timeouts, errores ambiguos y resultados potencialmente exitosos sin evidencia
suficiente requieren reconciliacion, no otro POST. Fallar al persistir incertidumbre
tampoco autoriza repetir. Solo rechazos definitivos reconocidos permiten failed;
ausencia de cargo, HTTP 404 o lista vacia no prueban un rechazo financiero.

El diagnostico consulta como maximo un cargo persistido con credenciales TEST de
la tienda, valida identidad/monto/PEN/metadata y devuelve observaciones limitadas.
`found_compatible` no significa capturado ni pagado. Sin charge_id no realiza
busquedas amplias: exige investigacion conservadora. Credenciales rotadas,
metadata ausente y referencias perdidas pueden impedir verificar cargos antiguos.

014 prepara reconciliacion idempotente con snapshot y auditoria, pero no aplica
paid/failed, no limpia reconciliacion ni libera claims. Su evento identifica
`prepare_reconciliation_v1`, `internal_reconciliation_preparation` y
`financial_evidence_verified=false`; no representa respuesta financiera verificada.

**Dependencia externa:** falta confirmacion oficial de Culqi sobre evidencia minima
de captura, semantica de paid/capture/capture_date, operaciones, devoluciones,
disputas y prueba independiente de autenticacion 3DS. No asumir equivalencias ni
idempotencia del proveedor. Ver [contrato conservador](functions/_shared/culqi-test-evidence.md).

## Incompatibilidades conocidas de Commerce

Verificadas en el repositorio hermano `../kafka-commerce`; no se modifico Commerce.

- `src/services/paymentAttempts.ts`: el payload omite device_finger_print_id,
  obligatorio en Core; el parser no conserva toda la informacion de continuacion 3DS.
- `src/components/OnlineCheckoutButton.tsx`: no integra la generacion del device,
  complete-payment-3ds ni consulta autorizada de estado; processing no completa 3DS.
- `src/hooks/useOnlineCheckout.ts`: token e idempotencia viven en memoria. Refresh,
  cierre o respuesta perdida no tienen recuperacion segura implementada. Replay sin
  token no permite recuperar una sesion; no reemitirla solo por conocer order_id.
- `src/services/orders.ts`: exige pending_payment para respuestas online, por lo
  que rechaza replays de ordenes que ya cambiaron a otros estados.
- Debe preservarse source original, device original, token y clave segun cada etapa;
  no crear una nueva identidad para reintentar un POST ambiguo.

Commerce mantiene preparacion y ejecucion online deshabilitadas. WhatsApp no
requiere sesion de pago y debe permanecer independiente.

## Riesgos pendientes y limites operativos

- **Finalizador privilegiado:** SQL 013 todavia puede finalizar paid si otro codigo
  con service_role lo solicita. Los claims antiguos tambien siguen como primitivas
  privilegiadas. La proteccion actual de los callers no es una prohibicion SQL global.
- **Abuso:** falta rate limiting durable del checkout. Antes de habilitar diagnostico,
  son obligatorias cuotas compartidas por owner/tienda y proteccion de entrada;
  CORS y limites por solicitud no limitan uso agregado. No usar un Map por instancia.
- **Flags:** create-payment-attempt selecciona la ruta real con MODE=culqi_test;
  no tiene un enable independiente equivalente al de complete-payment-3ds.
  Los flags de Commerce no protegen un endpoint desplegado frente a clientes directos.
- **Remoto pendiente:** versiones desplegadas, flags/secretos efectivos, permisos RLS
  y RPC efectivos, Vault, quotas/WAF, logging y automatizaciones de Cloudflare/CI.
  Un push no prueba esos valores. No registrar cuerpos, tokens ni argumentos sensibles.
- **Admin/catalogo:** guardar producto, subir imagen y vincular ruta son pasos
  separados. Un fallo parcial puede dejar un producto creado, duplicarlo al reintentar
  o dejar archivos huerfanos. Resolver antes de ampliar ese flujo. Cambios en tablas,
  vistas, precios, disponibilidad, Storage o RLS requieren regresion en ambos proyectos.

## Condiciones de avance

### TEST integrado controlado

1. Alinear contratos Commerce/Core: fingerprint, source, sesion, idempotencia,
   continuacion 3DS y consulta/recuperacion sin repetir POST.
2. Mantener canFinalizePaid=false hasta confirmar y revisar evidencia financiera.
   Un ejercicio TEST controlado puede validar incertidumbre, no afirmar pago aprobado.
3. Revisar barrera backend explicita de activacion, alcance de tienda/cuenta TEST,
   limites de uso y versiones compatibles; comprobar configuracion remota antes de
   cualquier despliegue o habilitacion autorizados por separado.
4. Ejecutar regresiones locales de autorizacion, concurrencia, expiracion/revocacion,
   fallos de red, 3DS, aislamiento y cero POST en duplicados/rechazos de claim.

### Pagos publicos futuros

Ademas de lo anterior: contrato oficial de evidencia confirmado; verificador y
aplicacion financiera transaccional revisados con snapshots/idempotencia/auditoria;
recuperacion y reconciliacion operables; limites durables y monitoreo sanitizado;
revision de todos los writers privilegiados y comprobacion remota de seguridad.
Este handoff no aprueba LIVE ni cambios a credenciales de produccion.

## Reglas permanentes de seguridad y cierre

- Mantener pagos y diagnostico deshabilitados mientras falten sus prerrequisitos.
- Nunca repetir un POST por timeout, error de red, refresh o respuesta ambigua.
- Nunca marcar paid sin evidencia financiera verificada. No confundir identidad,
  HTTP 200/201, autenticacion 3DS, autorizacion, captura y liquidacion.
- No liberar claims ni convertir incertidumbre en failed para permitir otro cargo.
- No exponer secretos, source, tokens, hashes o datos de autenticacion en logs,
  URLs, eventos o respuestas. Solo entregar el token al crear la sesion autorizada.
- Mejoras visuales pueden avanzar separadamente, sin habilitar flags ni alterar
  contratos compartidos. El cierre documental cubre hardening backend, no activacion
  de checkout online ni reconciliacion financiera automatizada.

Este cambio es documental: no ejecuta pruebas, migraciones, despliegues, consultas
remotas, cargos ni activaciones. Las validaciones historicas no certifican la
configuracion remota actual.
