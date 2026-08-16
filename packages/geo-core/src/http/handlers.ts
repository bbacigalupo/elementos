import type { GeoBias } from "../types.ts";
import type { GeoProvider } from "../providers/types.ts";
import { CircuitOpenError } from "../circuit-breaker.ts";
import { ProviderAuthError, ProviderRateLimitError } from "../fetch-retry.ts";

/**
 * Handlers HTTP portables del contrato de geocoding, en estándar web
 * (`Request` → `Response`). Se montan igual en Next.js, Hono, Bun,
 * Cloudflare Workers, o en Express/Vite/Node vía el adapter de ./node.ts.
 *
 * Contrato (todas GET):
 *   {base}/autocomplete?q&country&lat&lng&radiusKm&lang&limit
 *     → { ok: true, suggestions: Suggestion[] }
 *   {base}/geocode?q&country&lat&lng&radiusKm&lang
 *     → { ok: true, outcome: GeocodeOutcome | null }
 *   {base}/reverse?lat&lng&lang
 *     → { ok: true, value: LocationValue | null }
 *   Errores → { ok: false, error: string } con status 4xx/5xx.
 */

export interface GeoHandlersOptions {
  provider: GeoProvider;
  /**
   * Límite por cliente. Si se omite se aplica uno en memoria (120 req/min
   * por IP): el endpoint es público por necesidad —el navegador lo llama—
   * y dejarlo sin límite convierte cualquier despliegue en un proxy de
   * geocoding gratis para terceros. Con varias instancias conviene pasar
   * uno compartido (Redis, tabla en base de datos). `false` lo desactiva
   * de forma explícita.
   */
  rateLimit?: ((req: Request) => boolean | Promise<boolean>) | false;
  /**
   * Orígenes autorizados cuando el backend vive en otro dominio. Se acepta
   * una lista y se responde solo al origen que coincida.
   *
   * Evita a propósito recibir "*": con comodín cualquier sitio podría usar
   * tu cuota de geocoding desde el navegador de sus visitantes.
   */
  cors?: string | string[];
  /**
   * Tope propio de consultas diarias, para frenar ANTES de que el proveedor
   * lo haga.
   *
   * Sin esto, quedarse sin cuota se entera recién cuando el proveedor
   * empieza a devolver 429 — y en el tier gratuito, un 429 sostenido no
   * dice "hoy no queda más": el lote de geocodificación masiva lo ve
   * exactamente igual a un tropiezo de un segundo y lo reintenta con
   * backoff durante minutos antes de rendirse. Con un tope propio y
   * conservador, el aviso llega de inmediato ("quota_exhausted") y sin
   * gastar ni una consulta real de más contra el proveedor.
   *
   * Aplica a las tres rutas por igual (autocomplete, geocode, reverse):
   * el límite real es de la cuenta con el proveedor, no de una sola
   * pantalla. Quien quiera presupuestos separados por elemento monta dos
   * juegos de handlers con dos claves.
   */
  dailyQuota?: DailyQuota;
}

export interface GeoHandlers {
  autocomplete: (req: Request) => Promise<Response>;
  geocode: (req: Request) => Promise<Response>;
  reverse: (req: Request) => Promise<Response>;
  /** Estado de la cuota propia, si `dailyQuota` está configurada. */
  quota: (req: Request) => Promise<Response>;
  /** Router por sufijo de ruta: monta uno solo y resuelve los cuatro. */
  handle: (req: Request) => Promise<Response>;
}

/** División administrativa declarada, si viene en la petición. */
function parseAdminArea(params: URLSearchParams): { name: string; parentName?: string } | undefined {
  const name = params.get("area")?.trim();
  if (!name || name.length > 120) return undefined;
  const parentName = params.get("areaParent")?.trim();
  return { name, parentName: parentName && parentName.length <= 120 ? parentName : undefined };
}

function parseBias(params: URLSearchParams): GeoBias | null {
  const country = params.get("country");
  if (!country || !/^[a-zA-Z]{2}$/.test(country)) return null;
  const lat = params.get("lat");
  const lng = params.get("lng");
  const bias: GeoBias = { country: country.toUpperCase() };
  if (lat !== null && lng !== null) {
    const nLat = parseFloat(lat);
    const nLng = parseFloat(lng);
    if (!Number.isFinite(nLat) || !Number.isFinite(nLng)) return null;
    bias.center = { lat: nLat, lng: nLng };
  }
  const radius = params.get("radiusKm");
  if (radius !== null) {
    const n = parseFloat(radius);
    if (Number.isFinite(n) && n > 0) bias.radiusKm = n;
  }
  const lang = params.get("lang");
  if (lang && /^[a-zA-Z-]{2,10}$/.test(lang)) bias.lang = lang;
  return bias;
}

export function createGeoHandlers(opts: GeoHandlersOptions): GeoHandlers {
  const allowedOrigins = opts.cors
    ? (Array.isArray(opts.cors) ? opts.cors : [opts.cors]).filter((o) => o !== "*")
    : [];
  if (opts.cors && allowedOrigins.length === 0) {
    console.warn(
      '[geo-core] Se ignoró cors: "*". Indica los orígenes concretos; con comodín cualquier sitio puede gastar tu cuota de geocoding.',
    );
  }

  // Protegido por defecto: ver la documentación de `rateLimit`.
  const rateLimit = opts.rateLimit === false ? null : (opts.rateLimit ?? createMemoryRateLimit(120, 60));

  function headersFor(req: Request): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const origin = req.headers.get("origin");
    if (origin && allowedOrigins.includes(origin)) {
      headers["Access-Control-Allow-Origin"] = origin;
      headers["Access-Control-Allow-Methods"] = "GET, OPTIONS";
      headers["Vary"] = "Origin";
    }
    return headers;
  }

  async function guard(
    req: Request,
    fn: (params: URLSearchParams, json: (s: number, b: unknown) => Response) => Promise<Response>,
  ): Promise<Response> {
    const headers = headersFor(req);
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers });

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (req.method !== "GET") return json(405, { ok: false, error: "method_not_allowed" });
    if (rateLimit && !(await rateLimit(req))) {
      return json(429, { ok: false, error: "rate_limited" });
    }
    if (opts.dailyQuota && !opts.dailyQuota.hasRemaining()) {
      // Se frena antes de tocar al proveedor: no tiene sentido gastar la
      // consulta real solo para que el proveedor diga lo mismo.
      return json(503, { ok: false, error: "quota_exhausted", ...opts.dailyQuota.status() });
    }
    try {
      opts.dailyQuota?.use(1);
      return await fn(new URL(req.url).searchParams, json);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        return json(499, { ok: false, error: "aborted" });
      }
      if (err instanceof CircuitOpenError) {
        // El proveedor está caído y el circuito abierto: se responde rápido
        // y sin ruido en los registros, que para eso se abrió.
        return json(503, { ok: false, error: "provider_unavailable" });
      }
      if (err instanceof ProviderRateLimitError) {
        /*
         * El límite es del proveedor, no de este endpoint, pero para quien
         * llama significa lo mismo: espera y vuelve a intentar. Devolverlo
         * como 502 genérico hacía que el motor de lote lo tratara como una
         * dirección mala y la descartara tras dos reintentos de 300 ms.
         */
        if (err.retryAfterSeconds !== null) {
          headers["Retry-After"] = String(err.retryAfterSeconds);
        }
        return json(429, { ok: false, error: "rate_limited", source: "provider" });
      }
      if (err instanceof ProviderAuthError) {
        /*
         * Sin distinguirlo, una clave revocada se ve exactamente igual que
         * quinientas direcciones malas: cada fila del lote vuelve
         * "fallida" y nadie sospecha de la clave. 500 y no 4xx porque no es
         * culpa de quien llama — es la configuración del despliegue.
         */
        console.error("[geo-core] credencial del proveedor rechazada:", err);
        return json(500, { ok: false, error: "provider_auth_error" });
      }
      console.error("[geo-core] error del proveedor:", err);
      return json(502, { ok: false, error: "provider_error" });
    }
  }

  const autocomplete = (req: Request) =>
    guard(req, async (params, json) => {
      const q = params.get("q")?.trim() ?? "";
      const bias = parseBias(params);
      if (q.length < 2 || q.length > 200 || !bias) {
        return json(400, { ok: false, error: "bad_request" });
      }
      const limitRaw = parseInt(params.get("limit") ?? "5", 10);
      const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 5, 1), 10);
      const suggestions = await opts.provider.autocomplete(q, bias, {
        limit,
        adminArea: parseAdminArea(params),
        // Si quien preguntó ya se fue (siguió escribiendo, cerró la
        // pestaña), no tiene sentido seguir gastando cuota por un resultado
        // que nadie va a ver.
        signal: req.signal,
      });
      return json(200, { ok: true, suggestions });
    });

  const geocode = (req: Request) =>
    guard(req, async (params, json) => {
      const q = params.get("q")?.trim() ?? "";
      const bias = parseBias(params);
      if (q.length < 2 || q.length > 200 || !bias) {
        return json(400, { ok: false, error: "bad_request" });
      }
      const outcome = await opts.provider.geocode(q, bias, {
        adminArea: parseAdminArea(params),
        signal: req.signal,
      });
      return json(200, { ok: true, outcome });
    });

  const reverse = (req: Request) =>
    guard(req, async (params, json) => {
      const lat = parseFloat(params.get("lat") ?? "");
      const lng = parseFloat(params.get("lng") ?? "");
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
        return json(400, { ok: false, error: "bad_request" });
      }
      const lang = params.get("lang") ?? undefined;
      const value = await opts.provider.reverse(lat, lng, { lang, signal: req.signal });
      return json(200, { ok: true, value });
    });

  /*
   * No pasa por `guard`: consultar cuánto queda no debe gastar cuota, y
   * quien llama necesita la respuesta incluso cuando ya no queda nada —
   * es exactamente el momento en que más lo necesita.
   */
  const quota = (req: Request): Promise<Response> => {
    const headers = headersFor(req);
    if (req.method === "OPTIONS") return Promise.resolve(new Response(null, { status: 204, headers }));
    const body = opts.dailyQuota
      ? { ok: true, configured: true, ...opts.dailyQuota.status() }
      : { ok: true, configured: false };
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers }));
  };

  const handle = (req: Request): Promise<Response> => {
    const pathname = new URL(req.url).pathname;
    if (pathname.endsWith("/autocomplete")) return autocomplete(req);
    if (pathname.endsWith("/geocode")) return geocode(req);
    if (pathname.endsWith("/reverse")) return reverse(req);
    if (pathname.endsWith("/quota")) return quota(req);
    return Promise.resolve(
      new Response(JSON.stringify({ ok: false, error: "not_found" }), {
        status: 404,
        headers: headersFor(req),
      }),
    );
  };

  return { autocomplete, geocode, reverse, quota, handle };
}

export interface DailyQuotaStatus {
  limit: number;
  used: number;
  remaining: number;
  /** ISO 8601 de cuándo se repone. */
  resetsAt: string;
}

export interface DailyQuota {
  /** ¿Queda al menos una consulta hoy? */
  hasRemaining(): boolean;
  /** Registra consultas gastadas (1 por defecto). */
  use(n?: number): void;
  status(): DailyQuotaStatus;
}

/**
 * Tope propio de consultas diarias, para no depender de que el proveedor
 * avise cuando se acaba la suya.
 *
 * Vive en memoria del proceso: mismo aviso que los limitadores de arriba —
 * con varias instancias hace falta un contador compartido (Redis, una fila
 * en base de datos), o el tope real termina siendo `limit × instancias`.
 *
 * Se repone a medianoche UTC. No es necesariamente el mismo instante en que
 * el proveedor repone la suya, así que este tope conviene configurarlo con
 * margen (ej. 90% de la cuota real del proveedor) y no al límite exacto.
 */
export function createDailyQuota(limit: number): DailyQuota {
  let used = 0;
  let resetAt = nextUtcMidnight();

  function rollIfNeeded() {
    if (Date.now() >= resetAt) {
      used = 0;
      resetAt = nextUtcMidnight();
    }
  }

  return {
    hasRemaining() {
      rollIfNeeded();
      return used < limit;
    },
    use(n = 1) {
      rollIfNeeded();
      used += n;
    },
    status() {
      rollIfNeeded();
      return { limit, used, remaining: Math.max(0, limit - used), resetsAt: new Date(resetAt).toISOString() };
    },
  };
}

function nextUtcMidnight(): number {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
}

/**
 * Rate limiter en memoria por IP (ventana fija). Pensado para captura
 * individual: alguien escribiendo una dirección hace unas pocas consultas
 * espaciadas.
 *
 * **No sirve para geocodificación masiva.** Un lote de 500 direcciones son
 * 500 consultas seguidas del mismo navegador, y con el default de 120/min
 * el lote se corta a la cuarta parte —del lado del cliente se ve como
 * "fallaron 380 direcciones", no como "te pasaste del límite"—. Para esos
 * despliegues está `createBatchRateLimit`.
 *
 * Suficiente para un solo proceso; con múltiples instancias usa un limiter
 * compartido (Redis, tabla en base de datos) pasando tu propia función.
 */
export function createMemoryRateLimit(maxPerWindow: number, windowSeconds = 60) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (req: Request): boolean => {
    const ip =
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      req.headers.get("x-real-ip") ??
      "unknown";
    const now = Date.now();
    const entry = hits.get(ip);
    if (!entry || entry.resetAt < now) {
      if (hits.size > 10_000) hits.clear();
      hits.set(ip, { count: 1, resetAt: now + windowSeconds * 1000 });
      return true;
    }
    entry.count += 1;
    return entry.count <= maxPerWindow;
  };
}

export interface BatchRateLimitOptions {
  /**
   * Consultas sostenidas por minuto. Es el ritmo que el despliegue puede
   * mantener indefinidamente; conviene alinearlo con la cuota del
   * proveedor (LocationIQ free permite 2 por segundo).
   */
  ratePerMinute?: number;
  /**
   * Cuántas consultas puede gastar de golpe quien recién llega. Este es el
   * número que hace posible un lote: el balde arranca lleno, así que las
   * primeras N direcciones no esperan nada.
   */
  burst?: number;
}

/**
 * Rate limiter de balde con fichas (token bucket) por IP.
 *
 * La ventana fija de `createMemoryRateLimit` es el modelo equivocado para
 * lotes: reparte permisos en tajadas de un minuto, así que la consulta 121
 * no se demora —falla—, y quien está procesando 500 direcciones recibe
 * cientos de errores en vez de esperar un poco.
 *
 * El balde separa las dos cosas que un lote necesita a la vez: un ritmo
 * sostenido que respeta la cuota del proveedor, y una reserva inicial que
 * permite arrancar sin fricción. Sigue siendo un tope real —quien intente
 * usar el endpoint como proxy gratis se queda sin fichas igual—, solo que
 * deja de castigar el uso legítimo.
 *
 * Vive en memoria del proceso: en serverless cada instancia tiene el suyo.
 * Para volumen alto conviene uno respaldado en base de datos.
 */
export function createBatchRateLimit(options: BatchRateLimitOptions = {}) {
  const { ratePerMinute = 120, burst = 300 } = options;
  const perMs = ratePerMinute / 60_000;
  const buckets = new Map<string, { tokens: number; updatedAt: number }>();

  return (req: Request): boolean => {
    const ip =
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      req.headers.get("x-real-ip") ??
      "unknown";
    const now = Date.now();
    let bucket = buckets.get(ip);

    if (!bucket) {
      // Se limpia por tamaño y no por tiempo: recorrer el mapa entero en
      // cada petición costaría más que el propio límite.
      if (buckets.size > 10_000) buckets.clear();
      bucket = { tokens: burst, updatedAt: now };
      buckets.set(ip, bucket);
    } else {
      const recuperadas = (now - bucket.updatedAt) * perMs;
      bucket.tokens = Math.min(burst, bucket.tokens + recuperadas);
      bucket.updatedAt = now;
    }

    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  };
}
