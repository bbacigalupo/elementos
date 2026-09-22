import { canonicalAdminArea } from "../admin/index.ts";
import {
  formatAddress,
  type AddressComponents,
  type GeoBias,
  type GeocodeOutcome,
  type LocationValue,
  type MatchedLevel,
  type Precision,
  type Suggestion,
} from "../types.ts";
import { dedupeSuggestions } from "../suggestions.ts";
import { DEFAULT_USER_AGENT, fetchWithRetry, throwIfRateLimited, throwIfUnauthorized } from "../fetch-retry.ts";
import type { AutocompleteOptions, GeoProvider, RequestOptions } from "./types.ts";

/**
 * Mapbox Geocoding API v6 — EN PRUEBA (22 sept 2026), a pedido de Bernardo:
 * LocationIQ no le está dando buena precisión y quiere comparar antes de
 * decidir si paga el plan de Mapbox que permite guardar resultados.
 * Endpoint y forma de respuesta confirmados contra la documentación oficial
 * el mismo día (no asumidos de memoria — la API cambió de v5 a v6 desde el
 * corte de conocimiento).
 *
 * OJO CON EL ALMACENAMIENTO, es la razón de ser de esta nota: por defecto
 * Mapbox geocodifica en modo "temporal" (gratis hasta 100.000 consultas al
 * mes, pero **sus resultados no se pueden guardar** — solo mostrarse en
 * pantalla durante la sesión de quien pregunta). Guardarlos de todas formas
 * exige modo "permanente" (`permanent=true` en la consulta), que no tiene
 * tier gratis (USD 5/1.000) y requiere tarjeta o contrato empresarial en la
 * cuenta de Mapbox. Por eso `capabilities.cacheable` acá es `false` a menos
 * que `permanent: true` venga explícito en la config — `withCache` (en
 * `providers/index.ts`) respeta esa bandera y no persiste nada de este
 * proveedor mientras siga en modo temporal. **No activar `permanent: true`
 * sin que Bernardo haya confirmado que pagó ese plan.**
 */

const DEFAULT_BASE = "https://api.mapbox.com/search/geocode/v6";

interface MapboxContextEntry {
  name?: string;
  address_number?: string;
  street_name?: string;
  country_code?: string;
}

interface MapboxProperties {
  mapbox_id: string;
  feature_type: string;
  name: string;
  place_formatted?: string;
  coordinates: { longitude: number; latitude: number; accuracy?: string };
  context?: {
    address?: MapboxContextEntry;
    street?: MapboxContextEntry;
    neighborhood?: MapboxContextEntry;
    /**
     * En Chile (y Brasil) `locality` ES el nivel comuna — así lo documenta
     * la propia Mapbox ("Official sub-city features... city districts in
     * Brazil and Chile"). A diferencia de OSM, acá no hace falta adivinar
     * entre varios campos cuál es la comuna real.
     */
    locality?: MapboxContextEntry;
    district?: MapboxContextEntry;
    postcode?: MapboxContextEntry;
    place?: MapboxContextEntry;
    region?: MapboxContextEntry;
    country?: MapboxContextEntry;
  };
}

interface MapboxFeature {
  geometry: { coordinates: [number, number] };
  properties: MapboxProperties;
}

interface MapboxFeatureCollection {
  features: MapboxFeature[];
}

function pickCommune(country: string | null, c: NonNullable<MapboxProperties["context"]>): string | null {
  const candidate = c.locality?.name ?? c.district?.name ?? null;
  if (!candidate) return null;
  // Mismo criterio que el resto de los proveedores: se devuelve la grafía
  // del catálogo cuando existe, para que la columna Comuna del export
  // agrupe bien ("Ñuñoa" no debería convivir con variantes de escritura).
  return canonicalAdminArea(country, candidate) ?? candidate;
}

function mapComponents(p: MapboxProperties): AddressComponents {
  const c = p.context ?? {};
  const country = c.country?.country_code ?? null;
  return {
    street: c.street?.name ?? c.address?.street_name ?? null,
    number: c.address?.address_number ?? null,
    sublocality: c.neighborhood?.name ?? null,
    commune: pickCommune(country, c),
    city: c.place?.name ?? null,
    region: c.region?.name ?? null,
    postalCode: c.postcode?.name ?? null,
    country,
  };
}

function precisionOf(p: MapboxProperties): Precision {
  if (p.feature_type === "address" || p.feature_type === "secondary_address") {
    // Mapbox tiene su propia noción de "interpolated" (estimó la altura
    // dentro de un tramo conocido, no la confirmó) — coincide en espíritu
    // con nuestro `Precision:"interpolated"` de `interpolate/`, así que se
    // traduce directo en vez de mostrarlo como si fuera un match exacto.
    return p.coordinates.accuracy === "interpolated" ? "interpolated" : "rooftop";
  }
  if (p.feature_type === "street") return "street";
  return "zone";
}

/**
 * No se reusa `precisionToMatchedLevel` de `osm.ts`: esa función manda todo
 * lo que no es `rooftop`/`exact`/`street` a `"zone"`, lo cual está bien para
 * proveedores OSM (no tienen nivel intermedio) pero clasificaría mal un
 * `interpolated` de Mapbox como zona en vez de como una dirección estimada.
 */
function matchedLevelOf(precision: Precision): MatchedLevel {
  if (precision === "street") return "street";
  if (precision === "zone") return "zone";
  return "address";
}

function toLocationValue(f: MapboxFeature): LocationValue {
  const p = f.properties;
  const components = mapComponents(p);
  const fallback = p.place_formatted ? `${p.name}, ${p.place_formatted}` : p.name;
  return {
    lat: p.coordinates.latitude,
    lng: p.coordinates.longitude,
    formatted: formatAddress(components, fallback),
    components,
    placeId: p.mapbox_id,
    precision: precisionOf(p),
    source: "search",
    provider: "mapbox",
    capturedAt: new Date().toISOString(),
  };
}

function suggestionLabel(f: MapboxFeature): { label: string; sublabel: string } {
  const p = f.properties;
  const c = mapComponents(p);
  const streetLine = [c.street, c.number].filter(Boolean).join(" ");
  return {
    label: streetLine || p.name,
    sublabel: p.place_formatted ?? [c.commune, c.region].filter(Boolean).join(", "),
  };
}

export interface MapboxConfig {
  accessToken: string;
  baseUrl?: string;
  userAgent?: string;
  /**
   * `true` SOLO si la cuenta de Mapbox ya tiene el plan que permite
   * almacenar resultados (ver la nota de arriba). Manda `permanent=true` en
   * cada consulta y habilita la caché compartida (`capabilities.cacheable`).
   * Por omisión `false`: modo temporal, gratis, resultados de solo
   * pantalla.
   */
  permanent?: boolean;
}

export function createMapboxProvider(config: MapboxConfig): GeoProvider {
  if (!config.accessToken) throw new Error("Mapbox requiere accessToken");
  const base = (config.baseUrl ?? DEFAULT_BASE).replace(/\/$/, "");
  const headers = { "User-Agent": config.userAgent ?? DEFAULT_USER_AGENT };
  const permanent = config.permanent ?? false;

  async function mbFetch(path: string, params: Record<string, string>, signal?: AbortSignal): Promise<MapboxFeature[]> {
    const url = new URL(`${base}/${path}`);
    url.searchParams.set("access_token", config.accessToken);
    if (permanent) url.searchParams.set("permanent", "true");
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetchWithRetry(url, { headers, signal }, { signal });
    throwIfRateLimited("Mapbox", res);
    throwIfUnauthorized("Mapbox", res);
    if (!res.ok) throw new Error(`Mapbox respondió ${res.status}`);
    const body = (await res.json()) as MapboxFeatureCollection;
    return body.features ?? [];
  }

  function biasParams(bias: GeoBias): Record<string, string> {
    const params: Record<string, string> = { country: bias.country.toLowerCase() };
    if (bias.center) params.proximity = `${bias.center.lng},${bias.center.lat}`;
    if (bias.lang) params.language = bias.lang;
    return params;
  }

  /**
   * A diferencia de LocationIQ, la entrada estructurada de Mapbox (v6) pide
   * `address_number`/`street` como campos separados y no admite mezclarla
   * con `q` — nuestro texto ya llega limpio pero como una sola cadena (ver
   * `batch/clean.ts`), así que separarlo en campos propios exigiría un
   * parser nuevo solo para esto. Se sigue el mismo camino que Photon:
   * la comuna declarada se agrega al texto libre, no se usa la entrada
   * estructurada. Si la precisión medida acá no alcanza, ese parser es la
   * mejora natural siguiente.
   */
  function queryText(query: string, opts?: RequestOptions): string {
    const area = opts?.adminArea;
    return area ? [query, area.name, area.parentName].filter(Boolean).join(", ") : query;
  }

  return {
    name: "mapbox",
    capabilities: { autocomplete: true, geocode: true, reverse: true, cacheable: permanent },

    async autocomplete(query, bias, opts?: AutocompleteOptions): Promise<Suggestion[]> {
      const limit = opts?.limit ?? 5;
      const features = await mbFetch(
        "forward",
        { q: queryText(query, opts), autocomplete: "true", limit: String(Math.min(limit * 2, 10)), ...biasParams(bias) },
        opts?.signal,
      );
      const mapped = features.map((f, i) => {
        const value = { ...toLocationValue(f), source: "autocomplete" as const };
        const { label, sublabel } = suggestionLabel(f);
        return { id: value.placeId ?? `mapbox-${i}`, label, sublabel, value };
      });
      return dedupeSuggestions(mapped).slice(0, limit);
    },

    async geocode(query, bias, opts?: RequestOptions): Promise<GeocodeOutcome | null> {
      // autocomplete:false busca coincidencia completa en vez de prefijo —
      // es el equivalente de "un solo mejor resultado" que ya usan los
      // demás proveedores en `geocode()`.
      //
      // PENDIENTE (anotado, no una tarea activa — optimizador de rutas,
      // §11, 2026-09-22): `limit: "1"` toma el primer candidato de Mapbox a
      // ciegas, incluso con `bias.center` configurado. Probado con un caso
      // real: pedir "Los Aromos & Diego Portales" con proximity en
      // Santiago SÍ trae "Los Aromos, Estación Central" entre los
      // candidatos (confirmado pidiendo varios), pero como acá solo se
      // pide 1, Mapbox devuelve su candidato de mejor texto ("Diego
      // Portales", en Copiapó, a 800 km) y nunca llegamos a ver el bueno.
      // `bias.center`/`radiusKm` hoy solo sirven para re-rankear DENTRO de
      // lo que ya devolvió el proveedor (vía `classifyResult` → `far_from_bias`,
      // después de la consulta) — no para influir en qué candidato se pide.
      // El arreglo de verdad: pedir varios (`limit` más alto) cuando hay
      // `bias.center`, y preferir el más cercano entre los de relevancia
      // comparable, en vez del primero sin más. `photon.ts` y
      // `locationiq.ts` tienen exactamente el mismo patrón (`limit`/`1` fijo).
      const features = await mbFetch(
        "forward",
        { q: queryText(query, opts), autocomplete: "false", limit: "1", ...biasParams(bias) },
        opts?.signal,
      );
      if (features.length === 0) return null;
      const value = toLocationValue(features[0]);
      return { value, matchedLevel: matchedLevelOf(value.precision) };
    },

    async reverse(lat, lng, opts): Promise<LocationValue | null> {
      const params: Record<string, string> = { longitude: String(lng), latitude: String(lat) };
      if (opts?.lang) params.language = opts.lang;
      const features = await mbFetch("reverse", params, opts?.signal);
      if (features.length === 0) return null;
      const value = toLocationValue(features[0]);
      return { ...value, lat, lng, source: "pin" };
    },
  };
}
