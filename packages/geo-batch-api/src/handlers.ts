import {
  buildRows,
  estimateBatchQueries,
  runBatch,
  tableFromRows,
  type AddressFields,
  type ClassifyOptions,
  type GeoBias,
  type GeoClient,
  type OutlierOptions,
  type ParsedInput,
} from "@allride/geo-core";
import { AUTH_ERROR_TEXT, authenticate, quotaStatus, type AuthContext } from "./auth.ts";
import { createCorrectionLink, type CorrectionLinkConfig } from "./correction-links.ts";
import { generateId } from "./keys.ts";
import type { BatchStore } from "./store.ts";
import { toPublicJob, type ApiScope, type BatchJob, type JobStatus, type StoredRow } from "./types.ts";
import { buildJobPatch, fetchAllRows } from "./worker.ts";

/**
 * Endpoints HTTP de trabajos: crear, listar, consultar, borrar, y leer sus
 * filas. Mismo contrato portable (`Request` → `Response`) que geo-core, así
 * que se monta igual en Next.js, Hono, Bun, Cloudflare Workers o Express vía
 * un adapter — ver `http/node.ts` en geo-core para el patrón.
 *
 * Lo que este módulo **no** hace: geocodificar. Crear un trabajo solo lo
 * deja en `pending` con sus filas listas; quien lo procesa es el worker
 * (paso siguiente), leyendo `claimNextJob` del mismo `BatchStore`. La
 * separación importa porque una petición HTTP tiene un tiempo de espera
 * corto y un lote de 5.000 direcciones no cabe ahí.
 *
 * Contrato:
 *   POST   {base}            → crea un trabajo, `{ ok: true, job }` (201, o
 *                               200 si repite una `idempotencyKey` ya usada)
 *   GET    {base}             → lista trabajos del cliente, `{ ok, jobs }`
 *   GET    {base}/:id         → un trabajo, `{ ok, job }`
 *   DELETE {base}/:id         → lo borra, `{ ok, deleted: true }`
 *   GET    {base}/:id/rows    → sus filas, `{ ok, rows, total }`
 *   POST   {base}/:id/rows/:rowId/correction-link
 *                             → link firmado para esa fila, `{ ok, url, token, expiresAt }`
 *   Errores → `{ ok: false, error: string, ... }` con status 4xx/5xx.
 *
 * `POST {base}` con `{ ..., sync: true }` en el body es la excepción a "este
 * módulo no geocodifica": con `sync` configurado (ver `BatchApiHandlersOptions`)
 * y un lote lo bastante chico, la petición procesa el trabajo ella misma y
 * devuelve `{ ok, job, rows }` de una vez — sin eso, un cliente con 5
 * direcciones tendría que crear el trabajo, esperar a que un worker lo tome,
 * y hacer polling para algo que cabe perfectamente en una sola respuesta.
 */

export interface BatchApiHandlersOptions {
  store: BatchStore;
  /** Prefijo de ruta, ej. "/v1/batches" (default). */
  basePath?: string;
  /**
   * Tope de filas por trabajo. Es protección de tamaño de la petición, no
   * de cuota — una API sin este tope deja que una sola llamada intente
   * crear un trabajo de un millón de filas y se cuelgue ahí.
   */
  maxRowsPerJob?: number;
  /**
   * Días que vive un trabajo antes de que `purgeExpired` pueda borrarlo
   * (ver el paso de retención). Se necesita un valor desde el momento de
   * crear el trabajo — ningún trabajo nace sin fecha de vencimiento.
   */
  retentionDays?: number;
  /** Mismo criterio que geo-core: nunca "*", solo orígenes concretos. */
  cors?: string | string[];
  /**
   * Habilita `sync: true` al crear un trabajo. Sin esto configurado, pedirlo
   * se rechaza con `sync_not_configured` — el atajo necesita un `client`
   * para geocodificar, y los endpoints de trabajos por sí solos no lo
   * requieren (crear/listar/consultar nunca tocan al proveedor).
   */
  sync?: SyncOptions;
  /**
   * Habilita `POST {base}/:id/rows/:rowId/correction-link`. Sin esto
   * configurado, el endpoint responde `correction_links_not_configured` —
   * emitir un link firmado necesita un secreto del despliegue, y no todo
   * despliegue quiere ofrecer corrección por link.
   */
  correctionLinks?: CorrectionLinkConfig;
}

export interface SyncOptions {
  client: GeoClient;
  /**
   * Tope de filas que se aceptan procesar dentro de la misma petición. Un
   * cliente que pide `sync` para un lote grande se rechaza entero en vez de
   * degradar en silencio a asíncrono — quien integra debe poder confiar en
   * que si `sync: true` no dio error, `rows` viene en la respuesta.
   */
  maxRows?: number;
  /**
   * Cuánto esperar como máximo antes de responder con lo que se alcanzó a
   * procesar. Pasado esto, el trabajo vuelve a `pending` — no es una falla,
   * solo se dejó de bloquear la respuesta — y sigue disponible para que un
   * worker normal lo termine.
   */
  timeoutMs?: number;
  concurrency?: number;
  minIntervalMs?: number;
  retries?: number;
  rateLimitRetries?: number;
  rateLimitWaitMs?: number;
  classify?: ClassifyOptions;
  outliers?: OutlierOptions | false;
}

export interface BatchApiHandlers {
  createBatch: (req: Request) => Promise<Response>;
  listBatches: (req: Request) => Promise<Response>;
  getBatch: (req: Request, id: string) => Promise<Response>;
  deleteBatch: (req: Request, id: string) => Promise<Response>;
  listBatchRows: (req: Request, id: string) => Promise<Response>;
  mintCorrectionLink: (req: Request, id: string, rowId: string) => Promise<Response>;
  /** Router por ruta: monta uno solo y resuelve los seis. */
  handle: (req: Request) => Promise<Response>;
}

// ---------- forma del body de creación ----------

interface CreateBatchBody {
  /** Una dirección por elemento — el camino de texto libre. */
  addresses?: unknown;
  /** El camino tabular: encabezados + filas, como entrega un XLSX/CSV ya leído. */
  table?: { headers?: unknown; rows?: unknown };
  bias?: { country?: unknown; center?: { lat?: unknown; lng?: unknown }; radiusKm?: unknown; lang?: unknown };
  defaults?: Record<string, unknown>;
  idempotencyKey?: unknown;
  webhookUrl?: unknown;
  reference?: unknown;
  /**
   * Pide el atajo síncrono. Si `sync` no está configurado en el handler
   * (ver `BatchApiHandlersOptions`), se rechaza con `sync_not_configured`
   * en vez de crear el trabajo igual como si no se hubiera pedido — pedir
   * algo y que la respuesta no lo refleje es peor que un error claro.
   */
  sync?: unknown;
}

const MAX_ADDRESS_LEN = 300;
const DEFAULT_MAX_SYNC_ROWS = 10;
const DEFAULT_SYNC_TIMEOUT_MS = 8_000;
const JOB_STATUSES: JobStatus[] = ["pending", "running", "done", "cancelled", "failed"];
const ROW_STATUSES: StoredRow["status"][] = ["pending", "ok", "uncertain", "failed", "corrected"];

function parseBiasBody(body: CreateBatchBody["bias"]): GeoBias | null {
  const country = typeof body?.country === "string" ? body.country.trim() : "";
  if (!/^[a-zA-Z]{2}$/.test(country)) return null;
  const bias: GeoBias = { country: country.toUpperCase() };

  const lat = body?.center?.lat;
  const lng = body?.center?.lng;
  if (lat !== undefined || lng !== undefined) {
    if (typeof lat !== "number" || typeof lng !== "number" || !Number.isFinite(lat) || !Number.isFinite(lng)) {
      return null;
    }
    bias.center = { lat, lng };
  }
  if (body?.radiusKm !== undefined) {
    if (typeof body.radiusKm !== "number" || !(body.radiusKm > 0)) return null;
    bias.radiusKm = body.radiusKm;
  }
  if (typeof body?.lang === "string" && /^[a-zA-Z-]{2,10}$/.test(body.lang)) bias.lang = body.lang;
  return bias;
}

/** Del body de la petición a lo que `buildRows` entiende, o `null` si no trae ninguno válido. */
function parseInputBody(body: CreateBatchBody): ParsedInput | null {
  if (Array.isArray(body.addresses)) {
    const lines = body.addresses.filter(
      (a): a is string => typeof a === "string" && a.trim().length > 0 && a.length <= MAX_ADDRESS_LEN,
    );
    if (lines.length === 0) return null;
    return { kind: "lines", lines };
  }
  if (body.table && Array.isArray(body.table.rows)) {
    const rows = body.table.rows.filter((r): r is string[] =>
      Array.isArray(r) && r.every((c) => typeof c === "string"),
    );
    if (rows.length === 0) return null;
    const headers = Array.isArray(body.table.headers) && body.table.headers.every((h) => typeof h === "string")
      ? (body.table.headers as string[])
      : null;
    // `tableFromRows` espera los encabezados como la primera fila de los
    // datos crudos (así llega un XLSX ya leído); acá vienen aparte, en su
    // propio campo, así que hay que anteponerlos antes de pasarlos.
    return tableFromRows(headers ? [headers, ...rows] : rows, { hasHeader: headers !== null });
  }
  return null;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

// `toPublicJob` (types.ts) es la forma compartida — la misma que ven los
// endpoints y la que lleva un webhook, para que las dos copias nunca digan
// cosas distintas.
const serializeJob = toPublicJob;

export function createBatchApiHandlers(opts: BatchApiHandlersOptions): BatchApiHandlers {
  const { store } = opts;
  const basePath = (opts.basePath ?? "/v1/batches").replace(/\/$/, "");
  const maxRowsPerJob = opts.maxRowsPerJob ?? 2000;
  const retentionDays = opts.retentionDays ?? 30;
  const allowedOrigins = opts.cors
    ? (Array.isArray(opts.cors) ? opts.cors : [opts.cors]).filter((o) => o !== "*")
    : [];
  if (opts.cors && allowedOrigins.length === 0) {
    console.warn(
      '[geo-batch-api] Se ignoró cors: "*". Indica los orígenes concretos; con comodín cualquier sitio puede usar la API a nombre de tu clave.',
    );
  }

  function headersFor(req: Request): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const origin = req.headers.get("origin");
    if (origin && allowedOrigins.includes(origin)) {
      headers["Access-Control-Allow-Origin"] = origin;
      headers["Access-Control-Allow-Methods"] = "GET, POST, DELETE, OPTIONS";
      headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type";
      headers["Vary"] = "Origin";
    }
    return headers;
  }

  /**
   * Autentica, verifica el scope pedido, y solo entonces corre `fn`. Mismo
   * rol que `guard` en geo-core: un único lugar donde toda ruta pasa por
   * las mismas reglas, en vez de que cada handler repita su propia versión.
   *
   * Pasa el `AuthContext` completo (no solo el `tenantId`) porque crear un
   * trabajo necesita además la `ApiKeyRecord` para mirar su cuota — sin
   * esto, ese handler tendría que autenticar una segunda vez para
   * conseguirla, gastando otra consulta al store y registrando el uso dos
   * veces por una sola petición.
   */
  async function guard(
    req: Request,
    scope: ApiScope,
    fn: (auth: AuthContext, json: (status: number, body: unknown) => Response) => Promise<Response>,
  ): Promise<Response> {
    const headers = headersFor(req);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers });

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });

    const auth = await authenticate(req, store, { scope });
    if (!auth.ok) {
      const { code, status } = auth.error;
      const detail = code === "insufficient_scope" ? { required: auth.error.required } : {};
      return json(status, { ok: false, error: AUTH_ERROR_TEXT[code], ...detail });
    }

    try {
      return await fn(auth.context, json);
    } catch (err) {
      console.error("[geo-batch-api] error inesperado:", err);
      return json(500, { ok: false, error: "internal_error" });
    }
  }

  const createBatch = (req: Request) =>
    guard(req, "batches:write", async ({ tenantId, key }, json) => {
      let body: CreateBatchBody;
      try {
        body = await req.json();
      } catch {
        return json(400, { ok: false, error: "bad_request", detail: "body debe ser JSON válido" });
      }

      const sync = body.sync === true;
      if (sync && !opts.sync) {
        return json(400, {
          ok: false,
          error: "sync_not_configured",
          detail: "este despliegue no habilitó el atajo síncrono",
        });
      }

      // La idempotencia se resuelve ANTES de validar el resto: repetir la
      // misma petición (un reintento tras un timeout, típicamente) debe
      // devolver el trabajo que ya existe, no fallar por algo que cambió
      // en el reintento ni crear un segundo trabajo que cobre cuota de más.
      const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() : undefined;
      if (idempotencyKey) {
        const existing = await store.findByIdempotencyKey(tenantId, idempotencyKey);
        if (existing) {
          // Si esta repetición pide `sync`, la respuesta debe seguir
          // trayendo `rows` — quien integra no debería tener que notar que
          // esta vez fue un trabajo ya existente y no uno recién procesado.
          const rows = sync ? await fetchAllRows(store, tenantId, existing.id) : undefined;
          return json(200, { ok: true, job: serializeJob(existing), ...(rows ? { rows } : {}) });
        }
      }

      const bias = parseBiasBody(body.bias);
      if (!bias) return json(400, { ok: false, error: "bad_request", detail: "bias.country es obligatorio (ISO-3166-1 alpha-2)" });

      const parsed = parseInputBody(body);
      if (!parsed) {
        return json(400, {
          ok: false,
          error: "bad_request",
          detail: "se necesita `addresses` (lista de texto) o `table` (headers + rows)",
        });
      }

      const defaults = body.defaults as AddressFields | undefined;
      const built = buildRows(parsed, { defaults });
      if (built.rows.length === 0) {
        return json(400, { ok: false, error: "bad_request", detail: "ninguna fila tiene dirección que buscar" });
      }
      if (built.rows.length > maxRowsPerJob) {
        // Rechazo entero y no un recorte silencioso: una API que procesa
        // parte de lo que se le pidió, sin decirlo, es peor que una que
        // rechaza y explica el tope.
        return json(400, {
          ok: false,
          error: "too_many_rows",
          detail: `el trabajo tiene ${built.rows.length} filas; el máximo por trabajo es ${maxRowsPerJob}`,
          limit: maxRowsPerJob,
        });
      }
      const maxSyncRows = opts.sync?.maxRows ?? DEFAULT_MAX_SYNC_ROWS;
      if (sync && built.rows.length > maxSyncRows) {
        // Tampoco acá se degrada en silencio a asíncrono: si `sync: true`
        // no devuelve error, tiene que traer `rows`, siempre.
        return json(400, {
          ok: false,
          error: "too_many_rows_for_sync",
          detail: `el trabajo tiene ${built.rows.length} filas; el máximo para procesar en la misma petición es ${maxSyncRows}. Quita "sync" para crearlo de todos modos.`,
          limit: maxSyncRows,
        });
      }

      const needed = estimateBatchQueries(built.rows);
      const quota = await quotaStatus(store, key, new Date());
      if (quota.remaining !== null && needed > quota.remaining) {
        return json(429, {
          ok: false,
          error: "tenant_quota_exceeded",
          detail: `este trabajo necesita ${needed} consultas y hoy quedan ${quota.remaining} en tu plan`,
          needed,
          remaining: quota.remaining,
          limit: quota.limit,
          resetsAt: quota.resetsAt,
        });
      }

      const now = new Date();
      const workerId = sync ? generateId("sync") : undefined;
      const leaseUntil = sync
        ? new Date(now.getTime() + (opts.sync!.timeoutMs ?? DEFAULT_SYNC_TIMEOUT_MS) + 60_000).toISOString()
        : undefined;
      const job: BatchJob = {
        id: generateId("job"),
        tenantId,
        // "running" y no "pending" cuando es síncrono: esta misma petición
        // ya es quien lo procesa, y dejarlo "pending" lo haría candidato a
        // que un worker en paralelo también lo reclame — el doble gasto de
        // cuota que todo el mecanismo de arriendo existe para evitar.
        status: sync ? "running" : "pending",
        createdAt: now.toISOString(),
        startedAt: sync ? now.toISOString() : undefined,
        expiresAt: addDays(now, retentionDays).toISOString(),
        bias,
        sourceHeaders: built.sourceHeaders,
        rowCount: built.rows.length,
        summary: { total: built.rows.length, ok: 0, uncertain: 0, failed: 0, corrected: 0, pending: built.rows.length },
        queries: 0,
        idempotencyKey,
        webhookUrl: typeof body.webhookUrl === "string" ? body.webhookUrl : undefined,
        reference: typeof body.reference === "string" ? body.reference : undefined,
        workerId,
        leaseUntil,
      };
      const rows: StoredRow[] = built.rows.map((row) => ({
        jobId: job.id,
        updatedAt: now.toISOString(),
        row,
        status: "pending",
        value: null,
        matchedLevel: null,
        issues: [],
      }));

      await store.createJob(job, rows);

      if (!sync) return json(201, { ok: true, job: serializeJob(job) });

      const { client, timeoutMs = DEFAULT_SYNC_TIMEOUT_MS, ...runOpts } = opts.sync!;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let result;
      try {
        result = await runBatch(built.rows, { client, bias, ...runOpts, signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }

      const finishedAt = new Date();
      const patch: Partial<BatchJob> =
        result.cancelled && !result.stopReason
          ? {
              // Se acabó el tiempo que esta petición estaba dispuesta a
              // esperar — no es una falla del trabajo. Vuelve a quedar
              // disponible para que lo termine un worker normal.
              status: "pending",
              summary: result.summary,
              queries: job.queries + result.queries,
              workerId: undefined,
              leaseUntil: undefined,
            }
          : buildJobPatch(job, result, finishedAt, 10 * 60_000);

      const finalRows: StoredRow[] = result.results.map((r) => ({
        ...r,
        jobId: job.id,
        updatedAt: finishedAt.toISOString(),
      }));
      await store.saveRows(finalRows);
      await store.recordUsage(tenantId, result.queries, finishedAt);
      await store.updateJob(job.id, patch);

      return json(201, { ok: true, job: serializeJob({ ...job, ...patch }), rows: finalRows });
    });

  const listBatches = (req: Request) =>
    guard(req, "batches:read", async ({ tenantId }, json) => {
      const params = new URL(req.url).searchParams;
      const status = params.get("status")?.split(",").filter((s): s is JobStatus => JOB_STATUSES.includes(s as JobStatus));
      const limit = clampInt(params.get("limit"), 50, 1, 200);
      const offset = clampInt(params.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);

      const jobs = await store.listJobs(tenantId, { status: status?.length ? status : undefined, limit, offset });
      return json(200, { ok: true, jobs: jobs.map(serializeJob) });
    });

  const getBatch = (req: Request, id: string) =>
    guard(req, "batches:read", async ({ tenantId }, json) => {
      const job = await store.getJob(tenantId, id);
      if (!job) return json(404, { ok: false, error: "not_found" });
      return json(200, { ok: true, job: serializeJob(job) });
    });

  const deleteBatch = (req: Request, id: string) =>
    guard(req, "batches:write", async ({ tenantId }, json) => {
      const deleted = await store.deleteJob(tenantId, id);
      if (!deleted) return json(404, { ok: false, error: "not_found" });
      return json(200, { ok: true, deleted: true });
    });

  const listBatchRows = (req: Request, id: string) =>
    guard(req, "batches:read", async ({ tenantId }, json) => {
      // Se comprueba el trabajo aparte para poder devolver 404 de verdad:
      // `listRows` sobre un trabajo ajeno o inexistente vuelve vacío en
      // silencio (aislamiento por diseño), y acá eso confundiría "todavía
      // no hay filas" con "esto no es tuyo".
      const job = await store.getJob(tenantId, id);
      if (!job) return json(404, { ok: false, error: "not_found" });

      const params = new URL(req.url).searchParams;
      const status = params.get("status")?.split(",").filter((s): s is StoredRow["status"] => ROW_STATUSES.includes(s as StoredRow["status"]));
      const limit = clampInt(params.get("limit"), 100, 1, 500);
      const offset = clampInt(params.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);

      const { rows, total } = await store.listRows(tenantId, id, { status: status?.length ? status : undefined, limit, offset });
      return json(200, { ok: true, rows, total });
    });

  const mintCorrectionLink = (req: Request, id: string, rowId: string) =>
    guard(req, "corrections:write", async ({ tenantId }, json) => {
      if (!opts.correctionLinks) {
        return json(400, { ok: false, error: "correction_links_not_configured" });
      }
      // Se comprueba que la fila exista y sea del cliente ANTES de firmar:
      // emitir un link para algo que no existe no tiene para qué, y de
      // paso evita usar el endpoint para adivinar ids de filas ajenas.
      const row = await store.getRow(tenantId, id, rowId);
      if (!row) return json(404, { ok: false, error: "not_found" });

      const link = await createCorrectionLink(opts.correctionLinks, { tenantId, jobId: id, rowId });
      return json(201, { ok: true, ...link });
    });

  const handle = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (!url.pathname.startsWith(basePath)) {
      return new Response(JSON.stringify({ ok: false, error: "not_found" }), {
        status: 404,
        headers: headersFor(req),
      });
    }
    const segments = url.pathname.slice(basePath.length).replace(/^\/+/, "").split("/").filter(Boolean);
    const methodNotAllowed = () =>
      new Response(JSON.stringify({ ok: false, error: "method_not_allowed" }), {
        status: 405,
        headers: headersFor(req),
      });
    const notFound = () =>
      new Response(JSON.stringify({ ok: false, error: "not_found" }), { status: 404, headers: headersFor(req) });

    if (segments.length === 0) {
      if (req.method === "POST") return createBatch(req);
      if (req.method === "GET" || req.method === "OPTIONS") return listBatches(req);
      return methodNotAllowed();
    }
    if (segments.length === 1) {
      const [id] = segments;
      if (req.method === "GET" || req.method === "OPTIONS") return getBatch(req, id);
      if (req.method === "DELETE") return deleteBatch(req, id);
      return methodNotAllowed();
    }
    if (segments.length === 2 && segments[1] === "rows") {
      if (req.method === "GET" || req.method === "OPTIONS") return listBatchRows(req, segments[0]);
      return methodNotAllowed();
    }
    if (segments.length === 4 && segments[1] === "rows" && segments[3] === "correction-link") {
      if (req.method === "POST" || req.method === "OPTIONS") return mintCorrectionLink(req, segments[0], segments[2]);
      return methodNotAllowed();
    }
    return notFound();
  };

  return { createBatch, listBatches, getBatch, deleteBatch, listBatchRows, mintCorrectionLink, handle };
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const n = raw !== null ? parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
