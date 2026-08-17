# @allride/geo-batch-api

API de geocodificación masiva para sistemas externos. Sin dependencias y
**sin base de datos propia**: el paquete trae el contrato y la lógica, y
quien despliega implementa `BatchStore` con la tecnología que ya usa.

```
Sistema externo ──POST /v1/batches──▶ API ──▶ BatchStore  ← lo implementas tú
       ▲                               │
       │                           Worker ──▶ runBatch (@allride/geo-core)
       │                               │
       └──webhook / polling────────────┘
                                       │
       Persona ◀──link firmado─────────┘  → página de corrección
```

Ver [`examples/`](./examples) para un demo end-to-end runnable
(`npm run example -w @allride/geo-batch-api`) que ejercita el ciclo
completo — crear el trabajo, worker, webhook, link de corrección,
borrado — como lo vería un sistema externo real hablando por HTTP.

## Lo que hay que implementar

Una sola interfaz, `BatchStore`. Dos reglas que el contrato impone **por
firma**, no por disciplina:

1. **Todo método que sirve a una petición lleva `tenantId`.** No existe un
   `getJob(id)` a secas que un endpoint pueda llamar por descuido. El
   aislamiento entre clientes deja de depender de que alguien se acuerde de
   filtrar.
2. **Los métodos del worker no llevan tenant**, porque operan sobre un
   trabajo ya reclamado que trae el suyo adentro.

Para desarrollo y tests hay `createMemoryStore()`, que implementa la misma
semántica —incluida la atomicidad del reclamo— y sirve como referencia de
comportamiento. No sirve para producción: se pierde al reiniciar y no se
comparte entre instancias.

## Esquema Postgres

Listo para copiar. Los detalles que importan van comentados.

```sql
create table batch_jobs (
  id              text primary key,
  tenant_id       text not null,
  status          text not null check (status in ('pending','running','done','cancelled','failed')),
  created_at      timestamptz not null default now(),
  started_at      timestamptz,
  finished_at     timestamptz,
  -- Retención: purge_expired lo borra. No es una anotación, es la política.
  expires_at      timestamptz not null,
  bias            jsonb not null,
  source_headers  jsonb,
  row_count       integer not null default 0,
  summary         jsonb not null,
  -- Consultas al proveedor: es lo que se cobra y lo que corre contra la cuota.
  queries         integer not null default 0,
  idempotency_key text,
  webhook_url     text,
  reference       text,
  error           text,
  worker_id       text,
  lease_until     timestamptz
);

-- Idempotencia por cliente: dos clientes pueden usar la misma etiqueta.
create unique index batch_jobs_idem
  on batch_jobs (tenant_id, idempotency_key)
  where idempotency_key is not null;

create index batch_jobs_tenant on batch_jobs (tenant_id, created_at desc);
-- Índice del reclamo: lo consulta el worker en cada tick.
create index batch_jobs_claim on batch_jobs (status, created_at) where status in ('pending','running');
create index batch_jobs_expiry on batch_jobs (expires_at);

create table batch_rows (
  job_id        text not null references batch_jobs(id) on delete cascade,
  row_id        text not null,
  row_index     integer not null,
  status        text not null,
  input         jsonb not null,   -- BatchInputRow
  value         jsonb,            -- LocationValue
  matched_level text,
  issues        jsonb not null default '[]'::jsonb,
  corrected_at  timestamptz,
  from_duplicate boolean not null default false,
  updated_at    timestamptz not null default now(),
  primary key (job_id, row_id)
);

-- `on delete cascade` de arriba es lo que hace que borrar un trabajo se
-- lleve de verdad los domicilios, y no deje filas huérfanas.
create index batch_rows_review on batch_rows (job_id, status, row_index);

create table api_keys (
  id           text primary key,
  tenant_id    text not null,
  -- SHA-256 de la clave. La clave en claro NO se guarda nunca.
  key_hash     text not null unique,
  name         text not null,
  scopes       text[] not null,
  daily_quota  integer,           -- null = sin tope (claves internas)
  created_at   timestamptz not null default now(),
  revoked_at   timestamptz,
  last_used_at timestamptz
);

create table api_usage (
  tenant_id text not null,
  queries   integer not null,
  at        timestamptz not null default now()
);
create index api_usage_window on api_usage (tenant_id, at desc);
```

### El reclamo tiene que ser atómico

Es la única consulta con complejidad real. Sin `for update skip locked`,
dos workers se llevan el mismo trabajo y gastan la cuota dos veces:

```sql
update batch_jobs
   set status = 'running',
       worker_id = $1,
       lease_until = now() + ($2 || ' milliseconds')::interval,
       started_at = coalesce(started_at, now())
 where id = (
   select id from batch_jobs
    where status = 'pending'
       -- Rescate: un worker que se cayó dejó su arriendo vencido. Sin esta
       -- condición, un despliegue a mitad de lote lo cuelga para siempre.
       or (status = 'running' and lease_until < now())
    order by created_at
    limit 1
    for update skip locked
 )
returning *;
```

### La retención hay que agendarla

`purgeExpired()` no corre solo. Una política de retención que no se ejecuta
no es una política: es una promesa incumplida sobre domicilios de personas.

```sql
delete from batch_jobs where expires_at <= now();
```

Agéndalo (cron, `pg_cron`, un job programado) al menos una vez al día, y
comprueba que efectivamente corre.

## Claves de API

```ts
import { generateApiKey, hashApiKey } from "@allride/geo-batch-api";

const clave = generateApiKey();            // ark_live_… → se muestra UNA vez
const hash = await hashApiKey(clave);      // esto es lo que va a la base
```

El prefijo legible no es decoración: permite reconocer una clave filtrada en
un repositorio o en un log y saber al instante qué revocar.

Si se pierde, no se recupera — se emite otra. Es el punto de guardar solo el
hash: una filtración de la base no entrega acceso a nada.

## Links firmados de corrección (implementado)

`correction-links.ts` es cómo una persona SIN clave de API corrige una fila
—abriendo un link, sin cuenta ni login— sin exponer el resto del lote. No
hay tabla nueva: la autorización va firmada en el propio token
(HMAC-SHA256 sobre `tenantId`/`jobId`/`rowId`/vencimiento, con el secreto
del despliegue), así que emitir uno no necesita guardar nada.

```ts
import { createBatchApiHandlers } from "@allride/geo-batch-api";

const handlers = createBatchApiHandlers({
  store,
  correctionLinks: {
    secret: process.env.CORRECTION_LINK_SECRET!,   // solo del lado del servidor
    baseUrl: "https://miapp.cl/corregir",            // la página del paso siguiente
    ttlMs: 7 * 24 * 60 * 60 * 1000,                  // 7 días por defecto
  },
});
```

`POST {base}/:id/rows/:rowId/correction-link` (scope `corrections:write`,
distinto de `batches:write` — un cliente puede querer delegar "emitir links
de corrección" sin delegar "crear lotes nuevos") devuelve
`{ ok, url, token, expiresAt }`.

**La garantía que no se puede romper, para quien construya el paso
siguiente**: el `tenantId` que autoriza leer o corregir la fila sale
ÚNICAMENTE de `verifyCorrectionToken(...).payload`, nunca de la URL ni de
lo que declare el cliente — mismo principio que `BatchStore` ya exige para
toda lectura de la API.

## Página de corrección montable (implementado)

El lado que atiende a quien abre el link. Dos piezas nuevas:

**Servidor** — `correction-handlers.ts`, autenticación completamente
distinta de `handlers.ts` (el token en la URL es la única credencial, no
hay `Authorization`):

```
GET  {base}/:token   → la fila tal como está hoy, { ok, row }
POST {base}/:token   → aplica la corrección, { ok, row }
```

Corregir **propaga a toda la familia de filas repetidas** y **actualiza el
resumen del trabajo** — mismas dos reglas que ya tenía `applyCorrection` en
el elemento embebido, para que el resultado no dependa de si la corrección
llegó por la UI o por un link. Confirmar un punto ya exitoso sin moverlo no
cuenta como corrección (se decidió que el link queda **reutilizable**, no
de un solo uso: abrirlo de nuevo y confirmar el mismo punto es un no-op, no
un error — la persona pudo cerrar la pestaña sin querer).

**Navegador** — en `@allride/address-batch`: `<CorrectionPage>` +
`useCorrectionLink`. Reutiliza el mismo `<AddressInput>` que ya usa la
corrección dentro del lote — se extrajo `CorrectionForm` (el contenido) de
`RowCorrection` (que lo envolvía en un `<dialog>`) para que la página
standalone use el mismo contenido sin la chrome de modal, que no tiene
sentido en una página completa.

```tsx
<CorrectionPage
  token={token}                        // de la URL: ?token=…
  apiBaseUrl="https://api.miapp.cl/v1/corrections"
  client={httpClient("/api/geo")}      // para buscar mientras se escribe; no necesita el token
  bias={{ country: "CL" }}
/>
```

Verificado de punta a punta en el playground (pestaña "Corrección por
link"): crea un trabajo real por la API, emite un link real, lo abre, mueve
el pin, confirma, y lo que quedó guardado en el store coincide —
`status: "corrected"`, `provider: "corrección manual"`, resumen del
trabajo actualizado.

## Autenticación y endpoints de trabajos (implementado)

`authenticate()` en `auth.ts` es la única puerta de entrada al `tenantId`:
ningún handler lo recibe de la URL o el body, todos lo obtienen de la clave
autenticada. `createBatchApiHandlers()` en `handlers.ts` monta el contrato
`Request → Response` sobre `BatchStore`:

```
POST   {base}          crea un trabajo — { addresses } o { table }, + bias
GET    {base}          lista los trabajos del cliente
GET    {base}/:id       un trabajo
DELETE {base}/:id       lo borra
GET    {base}/:id/rows  sus filas, paginadas
```

Crear un trabajo **no geocodifica nada** — solo deja el trabajo y sus filas
en `pending`, listos para que el worker (`worker.ts`, `processNextJob`) los
reclame. La separación existe porque una petición HTTP tiene un tiempo de
espera corto y un lote de miles de direcciones no cabe ahí.

**Excepción — atajo síncrono, implementado**: `POST {base}` con
`{ ..., sync: true }` procesa el trabajo dentro de la misma petición y
devuelve `{ ok, job, rows }` de una vez, para el caso de un cliente que
manda un puñado de direcciones y no quiere hacer polling por algo que cabe
en una respuesta. Requiere `sync: { client, ... }` configurado al montar los
handlers (sin eso, `sync: true` se rechaza con `sync_not_configured` — un
despliegue no tiene por qué cargar un `GeoProvider` si nunca lo va a usar).
Un lote más grande que `sync.maxRows` (10 por defecto) se rechaza entero, no
se degrada en silencio a asíncrono. El trabajo se crea directo en `running`
con un arriendo propio — nunca `pending` — para que ningún worker en
paralelo lo reclame también y gaste la misma cuota dos veces; es la misma
garantía que ya provee `claimNextJob`, solo que acá la petición HTTP es su
propio worker de un solo uso. Si se acaba `sync.timeoutMs` (8 s por
defecto) antes de terminar, no es un error: el trabajo vuelve a `pending`
con lo alcanzado ya guardado, listo para que lo termine un worker normal —
mismo principio que un `stopReason` de cuota o proveedor caído, solo que
acá lo decide un límite de tiempo y no una señal del proveedor.

**Cuota al crear el trabajo, ya resuelto**: un lote que pide más consultas
de las que le quedan hoy al tenant se rechaza **al crearlo entero**, nunca
se procesa a medias — `429 tenant_quota_exceeded` con `needed`, `remaining`,
`limit`, `resetsAt` y un `detail` legible (mismo encuadre que
`quotaPreflight`/`overLimit` en `@allride/address-batch/texts.ts`: nombra
que el tope es del plan actual y ofrece contacto a ventas
(`https://allrideapp.com/contacto/`) — no es un mensaje distinto inventado
para la API, es el mismo límite visto desde otro cliente). Mismo patrón que
`/quota` en `geo-core/http` para el elemento embebido.

**La cuota que se agota a mitad de camino, no al crear.**
  `tenant_quota_exceeded` es la cuota del cliente contra su propio plan,
  chequeada antes de arrancar (paso anterior). Distinta de lo que hace el
  worker (`worker.ts`, este paso): cuando `runBatch` se detiene con
  `stopReason: "quota"` (nuestra cuota con el proveedor) o
  `"service_down"`, el trabajo queda `status: "paused"` — no `failed` — con
  `leaseUntil` marcando cuándo puede reintentarse y sus filas no
  procesadas en `pending`. `claimNextJob` rescata un `paused` con el
  arriendo vencido exactamente igual que a un `running` colgado: mismo
  campo, mismo mecanismo. `stopReason: "auth"` (credencial rechazada) sí
  va a `failed`, porque reintentar no la arregla sola. El webhook (ver
  abajo) avisa `batch.paused` y `batch.failed` además de `batch.done`, así
  que quien integra no tiene que hacer polling para enterarse de que su
  trabajo quedó a medias.

## Webhooks firmados (implementado)

Sin esto, enterarse de que un trabajo terminó exige hacer polling sobre
`GET {base}/:id`. Con `webhooks` configurado (en `worker.ts` y en
`correction-handlers.ts`), el sistema externo recibe un `POST` a la
`webhookUrl` que trajo el trabajo:

```ts
import { sendWebhook, verifyWebhookSignature } from "@allride/geo-batch-api";

// Al montar el worker o los handlers de corrección:
const webhooks = { secret: process.env.WEBHOOK_SECRET!, retries: 2, retryDelayMs: 1000 };
```

Cuatro eventos, cada uno atado a un único momento — nunca a mitad de
lote, para no obligar a quien integra a distinguir "terminó de verdad" de
"todavía le falta":

- `batch.done` — el worker terminó el trabajo completo.
- `batch.paused` — se detuvo por cuota o proveedor caído; se reintenta
  solo (ver arriba). `job.error` trae por qué.
- `batch.failed` — credencial rechazada; no se reintenta solo.
- `batch.row_corrected` — alguien corrigió una fila por un link firmado
  (paso anterior). No se envía si confirmar el punto no cambió nada
  (regla `sameSpot`) — ahí no hubo corrección que avisar.

Body siempre `{ type, createdAt, tenantId, job, row? }` — `job` es
`PublicBatchJob` (sin `workerId`/`leaseUntil`, que son detalle interno de
worker), `row` solo viene en `batch.row_corrected`. Firma HMAC-SHA256 del
body en el header `X-AllRide-Signature: sha256=<hex>`, más
`X-AllRide-Event` con el tipo — se verifica con `verifyWebhookSignature`.

```
POST {webhookUrl}
X-AllRide-Signature: sha256=…
X-AllRide-Event: batch.done
Content-Type: application/json

{ "type": "batch.done", "createdAt": "…", "tenantId": "…", "job": { … } }
```

Reintenta con backoff exponencial ante 5xx o error de red (`retries: 2`
por defecto — hasta 3 intentos en total); un 4xx no se reintenta, es la
integración la que está mal configurada, no algo transitorio. Nunca
lanza: una entrega fallida no debe verse como que el trabajo falló al
procesar, que sí se resolvió bien — el resultado queda en
`ProcessJobOutcome.webhookDelivery` para quien quiera registrar el intento.

**Un solo secreto para todo el despliegue, no uno por tenant** — mismo
patrón que `correctionLinks.secret`. Multi-tenant real querría rotación y
aislamiento por cliente; queda documentado como mejora pendiente, no
bloqueante para este alcance.

**Asincronía deliberadamente distinta según quién espera**: `worker.ts`
hace `await` de la entrega (es un proceso de fondo, nadie humano
esperando la respuesta). `correction-handlers.ts` la dispara sin esperar
(`void sendWebhook(...)`) — a quien corrigió ya se le confirmó con el 200
que quedó guardado; el webhook es para que el sistema externo se entere,
no para que ella espere más.

## Retención y borrado (implementado)

Todo lo que se guarda son domicilios de personas — ningún trabajo nace sin
fecha de vencimiento. `POST {base}` fija `expiresAt` al crear el trabajo,
`retentionDays` días adelante (30 por defecto, configurable al montar
`createBatchApiHandlers`). Borrar el trabajo también invalida de inmediato
cualquier link de corrección emitido sobre sus filas — no hay nada que
revocar aparte, el link solo sirve mientras la fila que firma existe.

`store.purgeExpired(now)` (en `BatchStore` desde el primer paso) borra lo
vencido. **El método por sí solo no es una política de retención — hay que
agendarlo de verdad**, y para eso está `runRetentionLoop`:

```ts
import { runRetentionLoop } from "@allride/geo-batch-api";

runRetentionLoop({
  store,
  intervalMs: 60 * 60_000, // cada hora alcanza de sobra; los trabajos viven días
  onPurge: (n) => n > 0 && console.log(`retención: ${n} trabajo(s) vencido(s) borrado(s)`),
});
```

Mismo rol que `runWorkerLoop` para el worker (paso anterior): conveniencia
para un proceso Node de larga duración, no la única forma de correrlo — un
cron real (`node-cron`, un cron job de Kubernetes, un scheduled function de
la nube que se use) que llame `store.purgeExpired(new Date())` una vez por
invocación sirve exactamente igual y no necesita esto. Purga una vez al
arrancar, sin esperar el primer intervalo completo, para que un despliegue
recién levantado no cargue con trabajos vencidos de antes de que el proceso
existiera.

**`store.purgeTenant(tenantId)` — deliberadamente sin endpoint HTTP en este
paquete.** Borra todo lo de un cliente: trabajos, filas y sus claves de
API. Es la operación que un cliente eventualmente va a pedir (baja de
cuenta, derecho de borrado), pero es irreversible y de alcance total —
incluida la clave con la que se autenticaría la propia petición que la
disparara — así que no es algo que deba colgar de un `DELETE` autenticado
solo con Bearer. Queda como función de `BatchStore` para que quien
despliegue la conecte a su propio flujo de soporte (verificación de
identidad, ticket, confirmación aparte de la sesión que la pide), no
expuesta como autoservicio.
