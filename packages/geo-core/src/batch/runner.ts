import type { GeoBias } from "../types.ts";
import type { GeoClient } from "../client/index.ts";
import { coordinatesFromRow, type BatchInputRow } from "./parse.ts";
import {
  applyOutliers,
  classifyResult,
  failedResult,
  summarize,
  type BatchResultRow,
  type BatchSummary,
  type ClassifyOptions,
  type OutlierOptions,
} from "./classify.ts";

/**
 * Motor de geocodificación por lote.
 *
 * Es deliberadamente **isomorfo**: no toca el DOM, no sabe de React y no
 * asume navegador. Hoy corre en la pestaña de quien usa el elemento; el día
 * que un lote de 20.000 direcciones necesite un trabajo en servidor, la
 * misma función corre allá sin reescribirla — solo cambia quién la llama y
 * dónde se guarda el progreso.
 *
 * Lo que resuelve, y que un `for` con `await` no resuelve:
 *
 * - **Ritmo**: los tiers gratuitos limitan por segundo, no por minuto.
 *   Disparar 500 consultas en paralelo consigue 500 errores 429, no
 *   velocidad.
 * - **Duplicados**: no se consultan dos veces. En una nómina de empresa
 *   varias personas comparten domicilio, y eso es cuota regalada.
 * - **Cancelación real**: detener significa detener, incluidas las
 *   consultas en vuelo.
 * - **Retomar**: un lote largo que se interrumpió no vuelve a empezar de
 *   cero.
 */

export interface BatchProgress {
  total: number;
  done: number;
  ok: number;
  uncertain: number;
  failed: number;
  /** Consultas enviadas al proveedor: sin duplicados, con reintentos. */
  queries: number;
  elapsedMs: number;
  /** Estimación de lo que falta; null hasta tener con qué estimar. */
  etaMs: number | null;
  /** Dirección que se está resolviendo, para mostrarla en pantalla. */
  current: string | null;
  /**
   * true mientras el lote está esperando a que el servicio deje de limitar.
   * La UI tiene que poder decirlo: una barra detenida sin explicación se
   * lee como que la herramienta se colgó.
   */
  paused: boolean;
  /** Se puso a `"quota" | "auth" | "service_down"` en cuanto el lote decide detenerse; ver `BatchStopReason`. */
  stopReason: BatchStopReason;
  /**
   * Marca de tiempo en que se reanuda la pausa, para poder mostrar una
   * cuenta regresiva. Esperar mirando un reloj se hace bastante más corto
   * que esperar mirando nada.
   */
  pausedUntil: number | null;
  /** Filas resueltas sin gastar consulta (repetidas y coordenadas). */
  saved: number;
}

/**
 * Por qué el lote se detuvo antes de terminar, cuando no fue la persona
 * quien lo canceló.
 *
 * Las tres situaciones se ven parecidas desde una sola fila —un error que
 * no cede— pero necesitan lo opuesto de quien está mirando: esperar
 * segundos (el freno normal, que no genera `stopReason`), esperar hasta
 * mañana (`"quota"`), avisar a quien administra la herramienta (`"auth"`),
 * o simplemente reintentar más tarde (`"service_down"`). Tratarlas todas
 * como "fila fallida" — lo que hacía el código antes de esto — convierte
 * cientos de direcciones perfectamente buenas en "provider_error" y nadie
 * sospecha de la cuota, la clave o el proveedor.
 */
export type BatchStopReason = "quota" | "auth" | "service_down" | null;

export interface BatchRunResult {
  results: BatchResultRow[];
  summary: BatchSummary;
  cancelled: boolean;
  stopReason: BatchStopReason;
  elapsedMs: number;
  queries: number;
}

export interface BatchRunOptions {
  client: GeoClient;
  bias: GeoBias;
  /**
   * Consultas simultáneas. Tres por defecto: es lo que toleran los tiers
   * gratuitos sin empezar a devolver 429, y subirlo no acelera nada cuando
   * el límite real es del proveedor.
   */
  concurrency?: number;
  /**
   * Milisegundos mínimos entre el inicio de dos consultas. LocationIQ free
   * permite 2 por segundo; Nominatim, 1. Es el freno que evita que un lote
   * termine bloqueando la cuenta.
   */
  minIntervalMs?: number;
  /** Reintentos por fila ante fallas de red o del proveedor. */
  retries?: number;
  /**
   * Reintentos adicionales cuando el servicio responde que se excedió el
   * límite. Van aparte de `retries` a propósito: toparse con la cuota no
   * es un fallo de la dirección, y gastar en eso los reintentos de red
   * dejaría sin defensa a la siguiente falla real.
   */
  rateLimitRetries?: number;
  /**
   * Espera base ante un límite excedido. Los limitadores por ventana se
   * reponen en decenas de segundos, así que reintentar a los 300 ms —lo
   * razonable para un tropiezo de red— solo consigue otro rechazo.
   */
  rateLimitWaitMs?: number;
  signal?: AbortSignal;
  classify?: ClassifyOptions;
  /** Detección de puntos alejados del resto. `false` la desactiva. */
  outliers?: OutlierOptions | false;
  onProgress?: (progress: BatchProgress) => void;
  /** Cada resultado apenas está listo, para ir pintando la tabla. */
  onResult?: (result: BatchResultRow) => void;
  /**
   * Resultados de una corrida anterior. Las filas ya resueltas no se
   * vuelven a consultar: así se retoma un lote interrumpido sin volver a
   * pagar lo ya pagado.
   */
  previous?: BatchResultRow[];
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

/**
 * ¿El servicio rechazó por exceso de consultas?
 *
 * Se reconoce por el texto porque el cliente HTTP entrega el código de
 * error del contrato (`rate_limited`) y no la respuesta cruda; se aceptan
 * también las formas que usan otros backends.
 */
function isRateLimit(message: string): boolean {
  return /rate.?limit|429|too.?many.?requests|quota/i.test(message);
}

/**
 * ¿El servidor ya sabe que hoy no queda cuota? Es el aviso preventivo de
 * `createDailyQuota` (ver http/handlers.ts) — llega antes de que el
 * proveedor diga nada, así que no hace falta gastar reintentos para
 * reconocerlo.
 */
function isQuotaExhausted(message: string): boolean {
  return /quota_exhausted/i.test(message);
}

/**
 * ¿La credencial configurada fue rechazada? No es un tropiezo de red ni un
 * límite temporal: reintentar no va a arreglar una clave vencida o
 * revocada, así que insistir fila por fila solo demora enterarse.
 */
function isAuthError(message: string): boolean {
  return /provider_auth_error|401|403|unauthorized|forbidden|credencial/i.test(message);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function pending(row: BatchInputRow): BatchResultRow {
  return { row, status: "pending", value: null, matchedLevel: null, issues: [] };
}

export async function runBatch(
  rows: BatchInputRow[],
  opts: BatchRunOptions,
): Promise<BatchRunResult> {
  const {
    client,
    bias,
    concurrency = 3,
    minIntervalMs = 0,
    retries = 2,
    rateLimitRetries = 4,
    rateLimitWaitMs = 5_000,
    signal,
    onProgress,
    onResult,
  } = opts;

  const startedAt = Date.now();
  const byId = new Map<string, BatchResultRow>();
  for (const row of rows) byId.set(row.id, pending(row));

  // Retomar: lo ya resuelto se conserva tal cual y no se vuelve a consultar.
  for (const previous of opts.previous ?? []) {
    if (previous.status !== "pending" && byId.has(previous.row.id)) {
      byId.set(previous.row.id, previous);
    }
  }

  let queries = 0;
  /** Filas resueltas sin consultar al proveedor. */
  let saved = 0;
  /**
   * Momentos en que se resolvió cada fila, para estimar por ritmo reciente.
   *
   * El promedio desde el arranque no sirve: cuando el lote se frena a mitad
   * de camino, un promedio acumulado sigue anclado al ritmo bueno del
   * principio y la estimación se queda congelada. Medido en la corrida de
   * 250: mostró "faltan 2 min" en seis lecturas seguidas mientras se
   * resolvían 78 filas.
   */
  const completions: number[] = [];
  const RATE_WINDOW = 20;
  /** Cuántas consultas están esperando a que se libere la cuota. */
  let paused = 0;
  /**
   * Freno compartido por todo el lote.
   *
   * Un límite de cuota es del servicio, no de una dirección: mientras un
   * worker espera su turno, los demás siguen consultando y siguen siendo
   * rechazados, así que cada uno agota sus reintentos por separado y el
   * lote termina con decenas de "fallidas" que no tenían nada de malo.
   * Medido con 250 direcciones reales contra LocationIQ: 40 fallidas con
   * reintento por fila, ninguna con este freno.
   *
   * `throttleUntil` detiene a todos hasta la misma hora; `extraIntervalMs`
   * baja el ritmo de ahí en adelante, porque toparse con el límite
   * significa que el ritmo elegido era demasiado alto.
   */
  let throttleUntil = 0;
  let extraIntervalMs = 0;
  let done = [...byId.values()].filter((r) => r.status !== "pending").length;
  const startingDone = done;

  /**
   * Se pone en cuanto una fila decide que el lote entero debe parar. A
   * partir de acá todos los workers dejan de tomar filas nuevas, en los
   * mismos puntos donde ya se revisa `signal?.aborted` — es la misma
   * mecánica de cancelación, solo que la decide el lote y no la persona.
   */
  let stopReason: BatchStopReason = null;
  /**
   * Fallas seguidas del proveedor que no son ni límite de cuota ni de
   * credencial — la señal de que el servicio está caído, no de que una
   * dirección puntual sea mala. Se resetea con cada éxito.
   */
  let consecutiveProviderErrors = 0;
  const SERVICE_DOWN_THRESHOLD = 5;
  function stopped(): boolean {
    return signal?.aborted === true || stopReason !== null;
  }

  function emitProgress(current: string | null) {
    if (!onProgress) return;
    const counts = summarize([...byId.values()]);
    const elapsedMs = Date.now() - startedAt;
    const etaMs = estimateRemaining();
    onProgress({
      total: byId.size,
      done,
      ok: counts.ok,
      uncertain: counts.uncertain,
      failed: counts.failed,
      queries,
      elapsedMs,
      etaMs,
      current,
      paused: paused > 0,
      pausedUntil: paused > 0 && throttleUntil > Date.now() ? throttleUntil : null,
      saved,
      stopReason,
    });
  }

  /**
   * Tiempo restante según el ritmo de las últimas filas, no del lote
   * entero. Reacciona a que el servicio empiece a frenar, que es
   * exactamente cuando la estimación importa.
   */
  function estimateRemaining(): number | null {
    const restantes = byId.size - done;
    if (restantes <= 0) return null;
    const ventana = completions.slice(-RATE_WINDOW);
    if (ventana.length < 2) return null;
    const lapso = ventana[ventana.length - 1] - ventana[0];
    if (lapso <= 0) return null;
    const porFila = lapso / (ventana.length - 1);
    return Math.round(porFila * restantes);
  }

  /*
   * Solo se consultan las filas originales; las duplicadas heredan el
   * resultado apenas se resuelve la suya. La cola de trabajo es entonces
   * más corta que el lote —ese es el ahorro— pero el progreso avanza con
   * todas las filas, que es lo que la persona está mirando.
   */
  const duplicatesOf = new Map<string, BatchInputRow[]>();
  for (const row of rows) {
    if (!row.duplicateOf) continue;
    const list = duplicatesOf.get(row.duplicateOf) ?? [];
    list.push(row);
    duplicatesOf.set(row.duplicateOf, list);
  }

  function record(result: BatchResultRow) {
    byId.set(result.row.id, result);
    done += 1;
    completions.push(Date.now());
    onResult?.(result);

    for (const duplicate of duplicatesOf.get(result.row.id) ?? []) {
      if (byId.get(duplicate.id)?.status !== "pending") continue;
      // Se marca para que en la exportación se sepa que esta fila no se
      // consultó por separado, sino que copió a otra idéntica.
      const inherited: BatchResultRow = { ...result, row: duplicate, fromDuplicate: true };
      byId.set(duplicate.id, inherited);
      done += 1;
      saved += 1;
      onResult?.(inherited);
    }
  }

  const queue = rows.filter((row) => !row.duplicateOf && byId.get(row.id)?.status === "pending");

  let next = 0;
  let lastStart = 0;

  async function worker() {
    for (;;) {
      if (stopped()) return;
      const index = next;
      next += 1;
      if (index >= queue.length) return;
      const row = queue[index];

      // Freno compartido: si el servicio pidió esperar, esperan todos.
      while (throttleUntil > Date.now()) {
        await delay(throttleUntil - Date.now(), signal);
        if (stopped()) return;
      }

      // Ritmo compartido entre workers: el límite del proveedor es global,
      // no por hilo.
      const interval = minIntervalMs + extraIntervalMs;
      if (interval > 0) {
        const wait = lastStart + interval - Date.now();
        lastStart = Math.max(Date.now(), lastStart + interval);
        if (wait > 0) await delay(wait, signal);
        if (stopped()) return;
      }

      emitProgress(row.raw);
      record(await geocodeRow(row));
      emitProgress(null);
    }
  }

  async function geocodeRow(row: BatchInputRow): Promise<BatchResultRow> {
    /*
     * Antes de gastar cuota: ¿la fila ya trae un punto? Pasa cuando alguien
     * pega coordenadas de Google Maps o cuando la columna venía
     * geocodificada de otro sistema. Mandarlas al buscador de direcciones
     * gastaba una consulta y las devolvía como fallidas.
     */
    const punto = coordinatesFromRow(row, bias);
    if (punto) {
      saved += 1;
      return { row, status: "ok", value: punto, matchedLevel: "address", issues: [] };
    }

    let lastError = "";
    let networkAttempts = 0;
    let limitAttempts = 0;

    for (;;) {
      try {
        queries += 1;
        const outcome = await client.geocode(row.query, bias, {
          adminArea: row.adminArea,
          signal,
        });
        // Un éxito demuestra que el servicio está respondiendo: lo que
        // falló antes eran tropiezos aislados, no una caída.
        consecutiveProviderErrors = 0;
        return classifyResult(row, outcome, opts.classify);
      } catch (err) {
        if (isAbort(err) || stopped()) return pending(row);
        lastError = err instanceof Error ? err.message : String(err);

        if (isAuthError(lastError)) {
          // Reintentar no arregla una clave vencida o revocada, y cada
          // fila que sigue va a chocar con lo mismo: se avisa una vez y se
          // detiene, en vez de convertir el lote entero en "fallidas".
          stopReason = "auth";
          return pending(row);
        }

        if (isQuotaExhausted(lastError)) {
          // El servidor ya confirmó que hoy no queda cuota: no hace falta
          // gastar reintentos para llegar a la misma conclusión.
          stopReason = "quota";
          return pending(row);
        }

        if (isRateLimit(lastError)) {
          if (limitAttempts >= rateLimitRetries) {
            /*
             * El freno compartido y varios reintentos con backoff ya
             * pasaron y el 429 sigue: no es un tropiezo de un segundo, es
             * la cuota del día. Insistir con lo que queda del lote solo
             * produciría "fallidas" que no tienen nada de malo — la
             * lección cara que ya costó una vez con LocationIQ, ahora un
             * nivel más arriba.
             */
            stopReason = "quota";
            return pending(row);
          }
          limitAttempts += 1;

          /*
           * Se frena el lote completo, no solo esta fila, y se baja el
           * ritmo para lo que queda. Sin lo segundo el lote volvería a
           * chocar contra el límite apenas se reanuda, una y otra vez.
           */
          const espera = rateLimitWaitMs * 2 ** (limitAttempts - 1) + Math.random() * 1000;
          throttleUntil = Math.max(throttleUntil, Date.now() + espera);
          extraIntervalMs = Math.min(Math.max(extraIntervalMs * 1.5, 250), 5_000);

          paused += 1;
          emitProgress(null);
          while (throttleUntil > Date.now()) {
            await delay(throttleUntil - Date.now(), signal);
            if (stopped()) break;
          }
          paused -= 1;
          if (stopped()) return pending(row);
          continue;
        }

        if (networkAttempts >= retries) {
          consecutiveProviderErrors += 1;
          if (consecutiveProviderErrors >= SERVICE_DOWN_THRESHOLD) {
            // Varias filas seguidas fallando de la misma forma no es "esta
            // dirección está mal" varias veces seguidas — es el servicio
            // caído. Se detiene en vez de agotar el lote fila por fila.
            stopReason = "service_down";
            return pending(row);
          }
          return failedResult(row, lastError);
        }
        networkAttempts += 1;
        await delay(300 * 2 ** (networkAttempts - 1) + Math.random() * 300, signal);
        if (stopped()) return pending(row);
      }
    }
  }

  emitProgress(null);
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()));

  // Duplicados de una corrida anterior: su original ya venía resuelto, así
  // que nunca pasó por `record` en esta vuelta.
  for (const row of rows) {
    if (!row.duplicateOf || byId.get(row.id)?.status !== "pending") continue;
    const original = byId.get(row.duplicateOf);
    if (!original || original.status === "pending") continue;
    byId.set(row.id, { ...original, row, fromDuplicate: true });
  }

  let results = rows.map((row) => byId.get(row.id) ?? pending(row));
  if (opts.outliers !== false) {
    results = applyOutliers(results, opts.outliers);
  }

  /*
   * Un lote que se detuvo solo por cuota/auth/caída no lo canceló la
   * persona, pero para quien lo consume importa lo mismo que una
   * cancelación: no terminó, quedaron filas pendientes, y conviene poder
   * retomarlo con la misma instantánea que ya existe para eso.
   */
  const cancelled = signal?.aborted === true || stopReason !== null;
  return {
    results,
    summary: summarize(results),
    cancelled,
    stopReason,
    elapsedMs: Date.now() - startedAt,
    queries,
  };
}

/**
 * Cuántas consultas reales va a gastar el lote: el total menos los
 * duplicados. No resta las filas que ya traen coordenadas (se resuelven
 * sin consultar) porque en ese caso conviene sobrestimar un poco antes de
 * arrancar — un aviso de cuota de más nunca sale caro; uno de menos sí.
 */
export function estimateBatchQueries(rows: BatchInputRow[]): number {
  return rows.filter((r) => !r.duplicateOf).length;
}

/**
 * Estimación de duración antes de arrancar, para poder advertir "esto va a
 * tomar unos 8 minutos" en vez de dejar a alguien esperando sin saber.
 */
export function estimateBatchMs(
  rows: BatchInputRow[],
  opts: { concurrency?: number; minIntervalMs?: number; perQueryMs?: number } = {},
): number {
  const { concurrency = 3, minIntervalMs = 0, perQueryMs = 400 } = opts;
  const queries = estimateBatchQueries(rows);
  const byRate = queries * minIntervalMs;
  const byLatency = (queries / Math.max(1, concurrency)) * perQueryMs;
  return Math.round(Math.max(byRate, byLatency));
}
