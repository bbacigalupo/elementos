import type { GeoBias } from "../types.ts";
import type { GeoProvider } from "../providers/types.ts";
import { CircuitOpenError } from "../circuit-breaker.ts";

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
}

export interface GeoHandlers {
  autocomplete: (req: Request) => Promise<Response>;
  geocode: (req: Request) => Promise<Response>;
  reverse: (req: Request) => Promise<Response>;
  /** Router por sufijo de ruta: monta uno solo y resuelve los tres. */
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
    try {
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

  const handle = (req: Request): Promise<Response> => {
    const pathname = new URL(req.url).pathname;
    if (pathname.endsWith("/autocomplete")) return autocomplete(req);
    if (pathname.endsWith("/geocode")) return geocode(req);
    if (pathname.endsWith("/reverse")) return reverse(req);
    return Promise.resolve(
      new Response(JSON.stringify({ ok: false, error: "not_found" }), {
        status: 404,
        headers: headersFor(req),
      }),
    );
  };

  return { autocomplete, geocode, reverse, handle };
}

/**
 * Rate limiter en memoria por IP (ventana fija). Suficiente para un solo
 * proceso; con múltiples instancias usa un limiter compartido (Redis, etc.)
 * pasando tu propia función `rateLimit`.
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
