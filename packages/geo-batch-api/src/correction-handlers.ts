import { haversineMeters, summarize, type LocationValue, type Precision } from "@allride/geo-core";
import { verifyCorrectionToken, type CorrectionLinkConfig } from "./correction-links.ts";
import { fetchAllRows } from "./worker.ts";
import type { BatchStore } from "./store.ts";
import { toPublicJob, type StoredRow } from "./types.ts";
import { sendWebhook, type WebhookConfig } from "./webhooks.ts";

/**
 * Endpoints públicos de corrección: los que atienden a quien **abre** un
 * link firmado (paso anterior), no a quien lo emite. Autenticación
 * completamente distinta de `handlers.ts` — acá no hay clave de API ni
 * `Authorization`, el token en la URL es la única credencial, y autoriza
 * exactamente una fila, no la cuenta completa de un cliente.
 *
 * Contrato:
 *   GET  {base}/:token   → la fila tal como está hoy, `{ ok, row }`
 *   POST {base}/:token   → aplica una corrección, `{ ok, row }`
 *   Errores de token (cualquiera de los dos verbos) → 401 con
 *   `malformed_token` | `invalid_token` | `expired_token`.
 */

export interface CorrectionHandlersOptions {
  store: BatchStore;
  correctionLinks: Pick<CorrectionLinkConfig, "secret">;
  /** Prefijo de ruta, ej. "/v1/corrections" (default). */
  basePath?: string;
  cors?: string | string[];
  /**
   * Avisa por webhook (`batch.row_corrected`) cuando alguien corrige una
   * fila por acá. No se envía si confirmar el punto no cambió nada (ver la
   * regla de `sameSpot` más abajo) — ahí no hubo corrección que avisar.
   */
  webhooks?: WebhookConfig;
}

export interface CorrectionHandlers {
  getRow: (req: Request, token: string) => Promise<Response>;
  submitCorrection: (req: Request, token: string) => Promise<Response>;
  handle: (req: Request) => Promise<Response>;
}

const TOKEN_ERROR_TEXT = {
  malformed: "malformed_token",
  invalid_signature: "invalid_token",
  expired: "expired_token",
} as const;

/** ¿Es prácticamente el mismo punto? Un metro de tolerancia cubre el redondeo. */
function sameSpot(a: LocationValue, b: LocationValue): boolean {
  return haversineMeters(a, b) < 1;
}

const PRECISIONS: readonly Precision[] = ["rooftop", "street", "zone", "exact"];

/** Valida el body de una corrección. Nada se asume: viene de fuera del sistema, sin la clave de API de por medio. */
function parseLocationValueBody(body: unknown): LocationValue | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.lat !== "number" || typeof b.lng !== "number") return null;
  if (!Number.isFinite(b.lat) || !Number.isFinite(b.lng) || Math.abs(b.lat) > 90 || Math.abs(b.lng) > 180) return null;
  if (typeof b.formatted !== "string") return null;
  if (typeof b.components !== "object" || b.components === null) return null;
  const c = b.components as Record<string, unknown>;
  const strOrNull = (v: unknown) => (typeof v === "string" ? v : null);
  if (typeof b.precision !== "string" || !PRECISIONS.includes(b.precision as Precision)) return null;

  return {
    lat: b.lat,
    lng: b.lng,
    formatted: b.formatted,
    components: {
      street: strOrNull(c.street),
      number: strOrNull(c.number),
      sublocality: strOrNull(c.sublocality),
      commune: strOrNull(c.commune),
      city: strOrNull(c.city),
      region: strOrNull(c.region),
      postalCode: strOrNull(c.postalCode),
      country: strOrNull(c.country),
    },
    placeId: typeof b.placeId === "string" ? b.placeId : undefined,
    precision: b.precision as Precision,
    // El origen y el proveedor los decide este endpoint, no quien llama:
    // lo que llega acá siempre es una persona confirmando un pin, nunca
    // otra cosa — aceptar lo que mande el body abriría la puerta a que
    // diga "search"/"otro-proveedor" sobre un dato que en realidad puso a mano.
    source: "pin",
    provider: "corrección manual",
    capturedAt: new Date().toISOString(),
  };
}

export function createCorrectionHandlers(opts: CorrectionHandlersOptions): CorrectionHandlers {
  const { store } = opts;
  const basePath = (opts.basePath ?? "/v1/corrections").replace(/\/$/, "");
  const allowedOrigins = opts.cors
    ? (Array.isArray(opts.cors) ? opts.cors : [opts.cors]).filter((o) => o !== "*")
    : [];

  function headersFor(req: Request): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const origin = req.headers.get("origin");
    if (origin && allowedOrigins.includes(origin)) {
      headers["Access-Control-Allow-Origin"] = origin;
      headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
      headers["Access-Control-Allow-Headers"] = "Content-Type";
      headers["Vary"] = "Origin";
    }
    return headers;
  }

  /**
   * Verifica el token y entrega el `payload` a `fn`, o responde el error
   * correspondiente. Mismo rol que `guard` en `handlers.ts`: un único
   * lugar donde se decide si el token alcanza, para que ningún handler
   * pueda saltárselo por descuido.
   */
  async function guard(
    req: Request,
    token: string,
    fn: (
      payload: { tenantId: string; jobId: string; rowId: string },
      json: (status: number, body: unknown) => Response,
    ) => Promise<Response>,
  ): Promise<Response> {
    const headers = headersFor(req);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers });

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });

    const verified = await verifyCorrectionToken(opts.correctionLinks, token);
    if (!verified.ok) return json(401, { ok: false, error: TOKEN_ERROR_TEXT[verified.error] });

    try {
      return await fn(verified.payload, json);
    } catch (err) {
      console.error("[geo-batch-api] error inesperado en corrección:", err);
      return json(500, { ok: false, error: "internal_error" });
    }
  }

  const getRow = (req: Request, token: string) =>
    guard(req, token, async ({ tenantId, jobId, rowId }, json) => {
      const row = await store.getRow(tenantId, jobId, rowId);
      if (!row) return json(404, { ok: false, error: "not_found" });
      return json(200, { ok: true, row });
    });

  const submitCorrection = (req: Request, token: string) =>
    guard(req, token, async ({ tenantId, jobId, rowId }, json) => {
      const row = await store.getRow(tenantId, jobId, rowId);
      if (!row) return json(404, { ok: false, error: "not_found" });

      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return json(400, { ok: false, error: "bad_request", detail: "body debe ser JSON válido" });
      }
      const value = parseLocationValueBody(body);
      if (!value) {
        return json(400, {
          ok: false,
          error: "bad_request",
          detail: "se necesita lat, lng, formatted, components y precision",
        });
      }

      // Confirmar un punto ya exitoso sin moverlo no es una corrección: no
      // cambió nada, y marcarlo "corregido" diría que una persona
      // intervino un dato que en realidad ya había resuelto el geocoder
      // — la misma regla que ya aplica el elemento embebido.
      if (row.status === "ok" && row.value && sameSpot(row.value, value)) {
        return json(200, { ok: true, row });
      }

      const now = new Date();
      /*
       * Las filas repetidas comparten dirección y heredaron el mismo
       * resultado; corregir solo la que se abrió dejaría a sus copias con
       * un punto que ya se sabe equivocado, sin que nadie vuelva a
       * revisarlas — el resumen del trabajo mostraría el problema como
       * resuelto. Se propaga a toda la familia, mismo criterio que
       * `applyCorrection` en el elemento embebido.
       */
      const family = row.row.duplicateOf ?? row.row.id;
      const todas = await fetchAllRows(store, tenantId, jobId);
      const actualizadas: StoredRow[] = todas
        .filter((r) => (r.row.duplicateOf ?? r.row.id) === family)
        .map((r) => ({
          ...r,
          status: "corrected",
          value,
          // El nivel de match era del geocoder; acá el punto lo puso una
          // persona y esa clasificación deja de tener sentido.
          matchedLevel: null,
          issues: [],
          correctedAt: now.toISOString(),
          updatedAt: now.toISOString(),
          fromDuplicate: r.row.id !== rowId,
        }));

      await store.saveRows(actualizadas);

      // El resumen del trabajo tiene que reflejar el cambio — sin esto,
      // `GET /v1/batches/:id` seguiría mostrando la fila como incierta
      // después de corregirla.
      const porId = new Map(actualizadas.map((r) => [r.row.id, r]));
      const completas = todas.map((r) => porId.get(r.row.id) ?? r);
      await store.updateJob(jobId, { summary: summarize(completas) });

      const corregida = actualizadas.find((r) => r.row.id === rowId)!;

      // Aparte, no bloqueando la respuesta a quien corrigió: a esa persona
      // ya le confirmamos que quedó guardado con el 200 de acá abajo — el
      // webhook es para que el sistema externo se entere, no ella.
      if (opts.webhooks) {
        const job = await store.getJob(tenantId, jobId);
        if (job?.webhookUrl) {
          void sendWebhook(opts.webhooks, job.webhookUrl, {
            type: "batch.row_corrected",
            createdAt: new Date().toISOString(),
            tenantId,
            job: toPublicJob(job),
            row: corregida,
          });
        }
      }

      return json(200, { ok: true, row: corregida });
    });

  const handle = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (!url.pathname.startsWith(basePath)) {
      return new Response(JSON.stringify({ ok: false, error: "not_found" }), {
        status: 404,
        headers: headersFor(req),
      });
    }
    const token = url.pathname.slice(basePath.length).replace(/^\/+/, "");
    if (!token) {
      return new Response(JSON.stringify({ ok: false, error: "not_found" }), {
        status: 404,
        headers: headersFor(req),
      });
    }
    if (req.method === "GET" || req.method === "OPTIONS") return getRow(req, token);
    if (req.method === "POST") return submitCorrection(req, token);
    return new Response(JSON.stringify({ ok: false, error: "method_not_allowed" }), {
      status: 405,
      headers: headersFor(req),
    });
  };

  return { getRow, submitCorrection, handle };
}
