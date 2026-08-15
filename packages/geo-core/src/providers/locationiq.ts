import type { GeoBias, GeocodeOutcome, LocationValue, Suggestion } from "../types.ts";
import { dedupeSuggestions } from "../suggestions.ts";
import { DEFAULT_USER_AGENT, fetchWithRetry } from "../fetch-retry.ts";
import { osmToLocationValue, osmToOutcome, viewboxFor, type OsmResult } from "./osm.ts";
import type { AutocompleteOptions, GeoProvider, RequestOptions } from "./types.ts";

/**
 * LocationIQ — datos OSM con API comercial. Free tier ~5.000 req/día y por
 * ser data OSM/ODbL permite almacenar los resultados (a diferencia de
 * Google). Requiere API key, así que en producción va siempre detrás del
 * proxy backend.
 *
 * Las sugerencias salen de `/search`, NO del endpoint `/autocomplete`. Ese
 * está pensado para nombres de lugares y resuelve mal las direcciones con
 * número, que es el caso central acá: con "Alicante 937" devolvía "937,
 * Málaga" —otra calle con el mismo número— y con la comuna pegada al texto
 * devolvía la comuna misma como primera opción. `/search` resuelve ambos
 * casos bien. Comprobado contra la API real.
 */

const DEFAULT_BASE = "https://api.locationiq.com/v1";

interface LocationIqResult extends OsmResult {
  display_place?: string;
  display_address?: string;
}

export interface LocationIqConfig {
  apiKey: string;
  baseUrl?: string;
  userAgent?: string;
}

export function createLocationIqProvider(config: LocationIqConfig): GeoProvider {
  if (!config.apiKey) throw new Error("LocationIQ requiere apiKey");
  const base = (config.baseUrl ?? DEFAULT_BASE).replace(/\/$/, "");
  const headers = { "User-Agent": config.userAgent ?? DEFAULT_USER_AGENT };

  async function liqFetch(
    path: string,
    params: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<LocationIqResult[]> {
    const url = new URL(`${base}/${path}`);
    url.searchParams.set("key", config.apiKey);
    url.searchParams.set("format", "json");
    url.searchParams.set("addressdetails", "1");
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetchWithRetry(url, { headers, signal }, { signal });
    if (res.status === 404) return []; // LocationIQ responde 404 en "sin resultados"
    if (!res.ok) throw new Error(`LocationIQ respondió ${res.status}`);
    const body = await res.json();
    return Array.isArray(body) ? body : [body];
  }

  function biasParams(bias: GeoBias): Record<string, string> {
    const params: Record<string, string> = { countrycodes: bias.country.toLowerCase() };
    if (bias.center) {
      params.viewbox = viewboxFor(bias.center, bias.radiusKm ?? 50);
      params.bounded = "0";
    }
    if (bias.lang) params["accept-language"] = bias.lang;
    return params;
  }

  /**
   * Con comuna declarada se usa la búsqueda estructurada (calle, ciudad y
   * región en campos propios), que es la que mejor resuelve calle+número.
   * Sin ella, texto libre.
   */
  function queryParams(query: string, opts?: RequestOptions): Record<string, string> {
    const area = opts?.adminArea;
    if (!area) return { q: query };
    const params: Record<string, string> = { street: query, city: area.name };
    if (area.parentName) params.state = area.parentName;
    return params;
  }

  function toSuggestion(r: LocationIqResult, index: number): Suggestion {
    const value = { ...osmToLocationValue(r, "locationiq"), source: "autocomplete" as const };
    const c = value.components;
    const streetLine = [c.street, c.number].filter(Boolean).join(" ");
    return {
      id: value.placeId ?? `liq-${r.place_id ?? index}`,
      label: r.display_place || streetLine || value.formatted.split(",")[0] || r.display_name,
      sublabel:
        r.display_address ||
        [r.display_place && streetLine ? streetLine : null, c.commune, c.region]
          .filter(Boolean)
          .join(", "),
      value,
    };
  }

  return {
    name: "locationiq",
    capabilities: { autocomplete: true, geocode: true, reverse: true },

    async autocomplete(query, bias, opts?: AutocompleteOptions): Promise<Suggestion[]> {
      const limit = opts?.limit ?? 5;
      const results = await liqFetch(
        "search",
        // Se piden de más porque OSM repite lugares y la deduplicación recorta.
        { ...queryParams(query, opts), limit: String(limit * 2), ...biasParams(bias) },
        opts?.signal,
      );
      return dedupeSuggestions(results.map(toSuggestion)).slice(0, limit);
    },

    async geocode(query, bias, opts?: RequestOptions): Promise<GeocodeOutcome | null> {
      const results = await liqFetch(
        "search",
        { ...queryParams(query, opts), limit: "1", ...biasParams(bias) },
        opts?.signal,
      );
      if (results.length === 0) return null;
      return osmToOutcome(results[0], "locationiq");
    },

    async reverse(lat, lng, opts): Promise<LocationValue | null> {
      const params: Record<string, string> = { lat: String(lat), lon: String(lng), zoom: "18" };
      if (opts?.lang) params["accept-language"] = opts.lang;
      const results = await liqFetch("reverse", params, opts?.signal);
      if (results.length === 0) return null;
      const value = osmToLocationValue(results[0], "locationiq");
      return { ...value, lat, lng, source: "pin" };
    },
  };
}
