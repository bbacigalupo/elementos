import type { GeoBias, GeocodeOutcome, LocationValue, Suggestion } from "../types.ts";
import { dedupeSuggestions } from "../suggestions.ts";
import { DEFAULT_USER_AGENT, fetchWithRetry } from "../fetch-retry.ts";
import { osmToLocationValue, osmToOutcome, viewboxFor, type OsmResult } from "./osm.ts";
import type { AutocompleteOptions, GeoProvider, RequestOptions } from "./types.ts";

/**
 * LocationIQ — datos OSM con API comercial. Free tier ~5.000 req/día,
 * incluye endpoint de autocomplete real, y por ser data OSM/ODbL permite
 * almacenar los resultados (a diferencia de Google). Requiere API key, así
 * que en producción va siempre detrás del proxy backend.
 */

const DEFAULT_BASE = "https://api.locationiq.com/v1";

interface LocationIqAutocompleteResult extends OsmResult {
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
  ): Promise<LocationIqAutocompleteResult[]> {
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

  return {
    name: "locationiq",
    capabilities: { autocomplete: true, geocode: true, reverse: true },

    async autocomplete(query, bias, opts?: AutocompleteOptions): Promise<Suggestion[]> {
      const limit = opts?.limit ?? 5;
      const results = await liqFetch(
        "autocomplete",
        // Margen para duplicados de OSM; se recorta tras deduplicar.
        { q: query, limit: String(limit * 2), ...biasParams(bias) },
        opts?.signal,
      );
      const mapped = results.map((r, i) => {
        const value = { ...osmToLocationValue(r, "locationiq"), source: "autocomplete" as const };
        return {
          id: value.placeId ?? `liq-${r.place_id ?? i}`,
          label: r.display_place ?? value.formatted.split(",")[0] ?? r.display_name,
          sublabel: r.display_address ?? "",
          value,
        };
      });
      return dedupeSuggestions(mapped).slice(0, limit);
    },

    async geocode(query, bias, opts?: RequestOptions): Promise<GeocodeOutcome | null> {
      const results = await liqFetch(
        "search",
        { q: query, limit: "1", ...biasParams(bias) },
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
