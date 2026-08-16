import type { GeoBias, GeocodeOutcome, LocationValue, Suggestion } from "../types.ts";
import { DEFAULT_USER_AGENT, fetchWithRetry, throwIfRateLimited } from "../fetch-retry.ts";
import { osmToLocationValue, osmToOutcome, viewboxFor, type OsmResult } from "./osm.ts";
import type { GeoProvider, RequestOptions } from "./types.ts";

/**
 * Nominatim público (nominatim.openstreetmap.org) — SOLO para desarrollo.
 * Sus TOS exigen máximo 1 request/segundo (throttle abajo), User-Agent
 * identificable, y prohíben autocompletado tecla a tecla y uso en
 * producción a volumen. Por eso `capabilities.autocomplete: false`.
 */

const DEFAULT_BASE = "https://nominatim.openstreetmap.org";

export interface NominatimConfig {
  baseUrl?: string;
  /** Identificación exigida por los TOS de Nominatim. */
  userAgent?: string;
}

let lastCall = 0;
async function throttle() {
  const now = Date.now();
  const wait = Math.max(0, lastCall + 1100 - now);
  lastCall = now + wait;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

export function createNominatimProvider(config: NominatimConfig = {}): GeoProvider {
  const base = (config.baseUrl ?? DEFAULT_BASE).replace(/\/$/, "");
  const userAgent = config.userAgent ?? DEFAULT_USER_AGENT;

  async function osmFetch(
    path: "search" | "reverse",
    params: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<OsmResult[]> {
    await throttle();
    const url = new URL(`${base}/${path}`);
    url.searchParams.set("format", "json");
    url.searchParams.set("addressdetails", "1");
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    // El header User-Agent no siempre se puede fijar desde navegador; en
    // server (el caso real) sí. Nominatim igual acepta el fallback.
    const res = await fetchWithRetry(url, { headers: { "User-Agent": userAgent }, signal }, { signal });
    if (res.status === 404) return [];
    throwIfRateLimited("Nominatim", res);
    if (!res.ok) throw new Error(`Nominatim respondió ${res.status}`);
    const body = await res.json();
    return Array.isArray(body) ? body : [body];
  }

  function biasParams(bias: GeoBias): Record<string, string> {
    const params: Record<string, string> = { countrycodes: bias.country.toLowerCase() };
    if (bias.center) {
      params.viewbox = viewboxFor(bias.center, bias.radiusKm ?? 50);
      // bounded=0: el viewbox prioriza, no excluye
      params.bounded = "0";
    }
    if (bias.lang) params["accept-language"] = bias.lang;
    return params;
  }

  return {
    name: "nominatim",
    capabilities: { autocomplete: false, geocode: true, reverse: true },

    async autocomplete(): Promise<Suggestion[]> {
      throw new Error(
        "Nominatim público no permite autocompletado (TOS). Usa Photon o LocationIQ.",
      );
    },

    async geocode(query, bias, opts?: RequestOptions): Promise<GeocodeOutcome | null> {
      // Con comuna declarada, campos estructurados: resuelven calle+número
      // mucho mejor que pegar todo en un texto libre.
      const area = opts?.adminArea;
      const queryParams: Record<string, string> = area
        ? { street: query, city: area.name, ...(area.parentName ? { state: area.parentName } : {}) }
        : { q: query };
      const results = await osmFetch(
        "search",
        { ...queryParams, limit: "1", ...biasParams(bias) },
        opts?.signal,
      );
      if (results.length === 0) return null;
      return osmToOutcome(results[0], "nominatim");
    },

    async reverse(lat, lng, opts): Promise<LocationValue | null> {
      const params: Record<string, string> = { lat: String(lat), lon: String(lng), zoom: "18" };
      if (opts?.lang) params["accept-language"] = opts.lang;
      const results = await osmFetch("reverse", params, opts?.signal);
      if (results.length === 0) return null;
      const value = osmToLocationValue(results[0], "nominatim");
      return { ...value, lat, lng, source: "pin" };
    },
  };
}
