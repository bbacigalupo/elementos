import {
  runBatch,
  type BatchRunResult,
  type ClassifyOptions,
  type GeoClient,
  type OutlierOptions,
} from "@allride/geo-core";
import { generateId } from "./keys.ts";
import type { BatchStore } from "./store.ts";
import { toPublicJob, type BatchJob, type StoredRow } from "./types.ts";
import { eventTypeForJobStatus, sendWebhook, type WebhookConfig, type WebhookDeliveryResult } from "./webhooks.ts";

/**
 * El worker: reclama un trabajo y lo corre contra `runBatch`, el mismo
 * motor que usa el elemento embebido. Es la pieza que conecta los
 * endpoints (paso anterior, que solo dejan trabajos en `pending`) con la
 * geocodificación de verdad.
 *
 * `processNextJob` reclama y procesa **uno solo** — no hace polling. Quien
 * despliega decide la cadencia: un `setInterval`, un cron, una cola. Para
 * el caso común de "un proceso Node de larga duración" está
 * `runWorkerLoop`, más abajo.
 */

export interface WorkerOptions {
  store: BatchStore;
  client: GeoClient;
  /** Identifica a este proceso en `worker_id`; solo sirve para depurar cuál tiene qué. */
  workerId?: string;
  /** Cuánto dura el arriendo mientras procesa. */
  leaseMs?: number;
  /** Cada cuánto se renueva. Bastante menor que `leaseMs`, para tolerar más de un aviso perdido. */
  heartbeatIntervalMs?: number;
  /** Cada cuántas filas resueltas se persiste el avance, además de al final y al pausar. */
  saveEveryRows?: number;
  /** Espera antes de reintentar un trabajo que se detuvo porque el proveedor no respondía. */
  serviceDownRetryMs?: number;
  concurrency?: number;
  minIntervalMs?: number;
  retries?: number;
  rateLimitRetries?: number;
  rateLimitWaitMs?: number;
  classify?: ClassifyOptions;
  outliers?: OutlierOptions | false;
  /**
   * Avisa por webhook cuando el trabajo termina, se pausa o falla — no al
   * crearlo ni a mitad de camino. Sin esto configurado, el trabajo igual
   * queda `done`/`paused`/`failed` como corresponde; solo que nadie se
   * entera sin hacer polling. Si el trabajo no trae `webhookUrl`, tampoco
   * se envía nada, esté esto configurado o no.
   */
  webhooks?: WebhookConfig;
}

export interface ProcessJobOutcome {
  /** false si no había ningún trabajo listo para reclamar. */
  claimed: boolean;
  job?: BatchJob;
  result?: BatchRunResult;
  /** Resultado de la entrega del webhook, si se intentó alguno. */
  webhookDelivery?: WebhookDeliveryResult;
  /**
   * true si otro worker se quedó con el arriendo a mitad de camino (ver
   * `heartbeat` en store.ts). Cuando pasa, este worker no escribió nada
   * más — ni las filas que alcanzó a resolver justo antes— porque el otro
   * ya se considera dueño y escribiría al mismo tiempo.
   */
  preempted?: boolean;
}

const ROWS_PAGE = 500;

/**
 * Todas las filas del trabajo, paginando — `listRows` no tiene un "sin
 * límite". Se reutiliza en el atajo síncrono (paso siguiente) para leer las
 * filas de un trabajo que ya existía por una `idempotencyKey` repetida.
 */
export async function fetchAllRows(store: BatchStore, tenantId: string, jobId: string): Promise<StoredRow[]> {
  const out: StoredRow[] = [];
  let offset = 0;
  for (;;) {
    const { rows, total } = await store.listRows(tenantId, jobId, { limit: ROWS_PAGE, offset });
    out.push(...rows);
    offset += rows.length;
    if (rows.length === 0 || offset >= total) break;
  }
  return out;
}

function nextUtcMidnight(now: Date): Date {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

/**
 * Del resultado de `runBatch` a lo que hay que guardar en el trabajo.
 *
 * Las tres razones de parada (`quota`, `auth`, `service_down`) necesitan
 * cosas distintas — mismo principio que ya se aplicó en el motor de lote y
 * en los mensajes del elemento embebido, un nivel más arriba acá: cuota y
 * caída se reintentan solas (`paused`), una credencial rechazada no se va
 * a arreglar reintentando (`failed`, para que alguien la revise).
 *
 * Exportada porque el atajo síncrono (`handlers.ts`) también corre
 * `runBatch` — sobre un trabajo recién creado, no reclamado por
 * `claimNextJob` — y necesita decidir lo mismo con el resultado.
 */
export function buildJobPatch(
  job: BatchJob,
  result: BatchRunResult,
  now: Date,
  serviceDownRetryMs: number,
): Partial<BatchJob> {
  const base: Partial<BatchJob> = {
    summary: result.summary,
    queries: job.queries + result.queries,
    // Se fija la primera vez que corre y no se pisa al retomar uno pausado:
    // si no, cada reintento resetearía cuánto lleva vivo el trabajo.
    startedAt: job.startedAt ?? now.toISOString(),
  };

  if (result.stopReason === "auth") {
    return {
      ...base,
      status: "failed",
      finishedAt: now.toISOString(),
      error: "El proveedor de direcciones rechazó la credencial configurada. Revisa la clave del despliegue.",
      workerId: undefined,
      leaseUntil: undefined,
    };
  }
  if (result.stopReason === "quota") {
    return {
      ...base,
      status: "paused",
      error: "Se acabó la cuota diaria con el proveedor de direcciones. Se reintenta solo cuando se repone.",
      leaseUntil: nextUtcMidnight(now).toISOString(),
      workerId: undefined,
    };
  }
  if (result.stopReason === "service_down") {
    return {
      ...base,
      status: "paused",
      error: "El servicio de direcciones no está respondiendo. Se reintenta solo en unos minutos.",
      leaseUntil: new Date(now.getTime() + serviceDownRetryMs).toISOString(),
      workerId: undefined,
    };
  }
  // Terminó de verdad — puede traer filas fallidas o inciertas, pero el
  // lote como tal no se interrumpió, así que no hay nada más que reintentar.
  return {
    ...base,
    status: "done",
    finishedAt: now.toISOString(),
    error: undefined,
    workerId: undefined,
    leaseUntil: undefined,
  };
}

/**
 * Reclama y procesa un solo trabajo, si hay alguno listo.
 *
 * Resume en vez de reprocesar: se leen TODAS las filas del trabajo (no solo
 * las pendientes) y se pasan como `previous` a `runBatch` — el mismo
 * mecanismo que ya usa el elemento embebido para retomar un lote
 * interrumpido. Las filas ya resueltas de una pausa anterior no se vuelven
 * a consultar.
 */
export async function processNextJob(opts: WorkerOptions): Promise<ProcessJobOutcome> {
  const {
    store,
    client,
    workerId = generateId("worker"),
    leaseMs = 5 * 60_000,
    heartbeatIntervalMs = Math.max(5_000, Math.floor(leaseMs / 3)),
    saveEveryRows = 25,
    serviceDownRetryMs = 10 * 60_000,
    concurrency,
    minIntervalMs,
    retries,
    rateLimitRetries,
    rateLimitWaitMs,
    classify,
    outliers,
    webhooks,
  } = opts;

  const job = await store.claimNextJob(workerId, leaseMs);
  if (!job) return { claimed: false };

  const stored = await fetchAllRows(store, job.tenantId, job.id);
  const rows = stored.map((s) => s.row);

  const controller = new AbortController();
  let preempted = false;

  /*
   * Mientras corre, se renueva el arriendo — si otro worker ya se lo
   * quedó (arriendo vencido y reclamado por otro), `heartbeat` devuelve
   * false y hay que soltarlo de inmediato: seguir consultando gastaría
   * cuota que el otro worker también está gastando sobre el mismo lote.
   */
  const heartbeatTimer = setInterval(() => {
    void store.heartbeat(job.id, workerId, leaseMs).then((ok) => {
      if (!ok) {
        preempted = true;
        controller.abort();
      }
    });
  }, heartbeatIntervalMs);

  let buffer: StoredRow[] = [];
  async function flush(force: boolean): Promise<void> {
    if (buffer.length === 0) return;
    if (!force && buffer.length < saveEveryRows) return;
    const lote = buffer;
    buffer = [];
    await store.saveRows(lote);
  }

  let result: BatchRunResult;
  try {
    result = await runBatch(rows, {
      client,
      bias: job.bias,
      concurrency,
      minIntervalMs,
      retries,
      rateLimitRetries,
      rateLimitWaitMs,
      classify,
      outliers,
      previous: stored,
      signal: controller.signal,
      onResult: (r) => {
        buffer.push({ ...r, jobId: job.id, updatedAt: new Date().toISOString() });
        void flush(false);
      },
    });
  } finally {
    clearInterval(heartbeatTimer);
  }

  if (preempted) {
    return { claimed: true, job, result, preempted: true };
  }

  await flush(true);

  const now = new Date();
  // La cuota del cliente (paso 3) se mide sobre esto: sin este registro,
  // `quotaStatus` nunca vería una consulta gastada y el tope no haría nada.
  await store.recordUsage(job.tenantId, result.queries, now);

  const patch = buildJobPatch(job, result, now, serviceDownRetryMs);
  await store.updateJob(job.id, patch);

  const finalJob: BatchJob = { ...job, ...patch };
  const webhookDelivery = await notifyJobOutcome(webhooks, finalJob);

  return { claimed: true, job: finalJob, result, webhookDelivery };
}

/**
 * Avisa por webhook cómo terminó el trabajo, si corresponde. No lanza —una
 * entrega fallida no debe hacer que `processNextJob` se vea como que falló
 * al procesar el trabajo, que sí se resolvió bien.
 */
async function notifyJobOutcome(
  webhooks: WebhookConfig | undefined,
  job: BatchJob,
): Promise<WebhookDeliveryResult | undefined> {
  if (!webhooks || !job.webhookUrl) return undefined;
  const type = eventTypeForJobStatus(job.status);
  if (!type) return undefined;

  return sendWebhook(webhooks, job.webhookUrl, {
    type,
    createdAt: new Date().toISOString(),
    tenantId: job.tenantId,
    job: toPublicJob(job),
  });
}

// ---------- loop de conveniencia ----------

export interface WorkerLoopOptions extends WorkerOptions {
  /** Espera antes de volver a preguntar cuando no había nada para reclamar. */
  idlePollMs?: number;
  signal?: AbortSignal;
  onJobProcessed?: (outcome: ProcessJobOutcome) => void;
  onError?: (err: unknown) => void;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

/**
 * `processNextJob` en bucle, para el caso común de un proceso Node de
 * larga duración. No es la única forma de correrlo — un cron que llama a
 * `processNextJob` una vez por invocación sirve igual y no necesita esto.
 */
export async function runWorkerLoop(opts: WorkerLoopOptions): Promise<void> {
  const { idlePollMs = 5_000, signal, onJobProcessed, onError, ...rest } = opts;
  while (!signal?.aborted) {
    try {
      const outcome = await processNextJob(rest);
      onJobProcessed?.(outcome);
      if (!outcome.claimed) await delay(idlePollMs, signal);
    } catch (err) {
      onError?.(err);
      await delay(idlePollMs, signal);
    }
  }
}
