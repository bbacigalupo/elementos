import {
  formatAddress,
  type AddressComponents,
  type GeoBias,
  type GeocodeOutcome,
  type LocationValue,
  type Precision,
  type Suggestion,
} from "../types.ts";
import { dedupeSuggestions } from "../suggestions.ts";
import { DEFAULT_USER_AGENT, fetchWithRetry } from "../fetch-retry.ts";
import { precisionToMatchedLevel } from "./osm.ts";
import type { AutocompleteOptions, GeoProvider, RequestOptions } from "./types.ts";

/**
 * Photon (photon.komoot.io) — geocoder OSM gratuito y sin API key, diseñado
 * para autocompletado tecla a tecla (search-as-you-type), que es justo lo
 * que Nominatim maneja mal. Soporta CORS, así que también sirve en el
 * navegador directo para demos/prototipos.
 *
 * Limitaciones: no tiene filtro por país (se filtra acá post-respuesta) y
 * su parámetro `lang` solo acepta en/de/fr (si no, se omite y devuelve
 * nombres locales — que en Chile ya vienen en español).
 */

interface PhotonProperties {
  osm_id?: number;
  osm_type?: string;
  osm_key?: string;
  osm_value?: string;
  type?: string;
  name?: string;
  housenumber?: string;
  street?: string;
  district?: string;
  city?: string;
  town?: string;
  village?: string;
  municipality?: string;
  county?: string;
  state?: string;
  postcode?: string;
  country?: string;
  countrycode?: string;
}

interface PhotonFeature {
  geometry: { coordinates: [number, number] };
  properties: PhotonProperties;
}

const PHOTON_LANGS = new Set(["en", "de", "fr"]);

function mapComponents(p: PhotonProperties): AddressComponents {
  return {
    street: p.street ?? (p.type === "street" ? (p.name ?? null) : null),
    number: p.housenumber ?? null,
    sublocality: p.district ?? null,
    commune: p.city ?? p.town ?? p.village ?? p.municipality ?? p.district ?? p.county ?? null,
    city: p.city ?? p.town ?? null,
    region: p.state ?? null,
    postalCode: p.postcode ?? null,
    country: p.countrycode ? p.countrycode.toUpperCase() : null,
  };
}

function precisionOf(p: PhotonProperties): Precision {
  if (p.housenumber) return "rooftop";
  if (p.street || p.type === "street") return "street";
  return "zone";
}

function toLocationValue(f: PhotonFeature): LocationValue {
  const p = f.properties;
  const components = mapComponents(p);
  const [lng, lat] = f.geometry.coordinates;
  const base = formatAddress(components);
  // Para POIs (plazas, estaciones, comercios) el nombre encabeza la dirección.
  const isPoi = p.name && p.name !== components.street && p.name !== components.commune;
  return {
    lat,
    lng,
    formatted: isPoi ? [p.name, base].filter(Boolean).join(", ") : base || (p.name ?? ""),
    components,
    placeId: p.osm_id != null ? `${p.osm_type ?? "osm"}:${p.osm_id}` : undefined,
    precision: precisionOf(p),
    source: "search",
    provider: "photon",
    capturedAt: new Date().toISOString(),
  };
}

function suggestionLabel(f: PhotonFeature): { label: string; sublabel: string } {
  const p = f.properties;
  const streetLine = [p.street ?? (p.type === "street" ? p.name : null), p.housenumber]
    .filter(Boolean)
    .join(" ");
  const label = (p.name && p.type !== "street" ? p.name : streetLine) || streetLine || p.name || "—";
  const c = mapComponents(p);
  const sublabel = [
    p.name && streetLine && p.name !== streetLine ? streetLine : null,
    c.commune,
    c.region,
  ]
    .filter(Boolean)
    .join(", ");
  return { label, sublabel };
}

export interface PhotonConfig {
  baseUrl?: string;
  /** Identificación enviada al proveedor; ver DEFAULT_USER_AGENT. */
  userAgent?: string;
}

export function createPhotonProvider(config: PhotonConfig = {}): GeoProvider {
  const base = (config.baseUrl ?? "https://photon.komoot.io").replace(/\/$/, "");
  const headers = { "User-Agent": config.userAgent ?? DEFAULT_USER_AGENT };

  async function search(
    query: string,
    bias: GeoBias,
    limit: number,
    signal?: AbortSignal,
  ): Promise<PhotonFeature[]> {
    const url = new URL(`${base}/api/`);
    url.searchParams.set("q", query);
    // Pedimos de más porque el filtro por país es post-respuesta.
    url.searchParams.set("limit", String(Math.min(limit * 3, 18)));
    if (bias.center) {
      url.searchParams.set("lat", String(bias.center.lat));
      url.searchParams.set("lon", String(bias.center.lng));
      url.searchParams.set("zoom", "11");
      url.searchParams.set("location_bias_scale", "0.4");
    }
    if (bias.lang && PHOTON_LANGS.has(bias.lang)) url.searchParams.set("lang", bias.lang);

    const res = await fetchWithRetry(url, { headers, signal }, { signal });
    if (!res.ok) throw new Error(`Photon respondió ${res.status}`);
    const body = (await res.json()) as { features?: PhotonFeature[] };
    const features = body.features ?? [];
    const country = bias.country.toUpperCase();
    return features
      .filter((f) => {
        const code = f.properties.countrycode?.toUpperCase();
        return !code || code === country;
      })
      .slice(0, limit);
  }

  return {
    name: "photon",
    capabilities: { autocomplete: true, geocode: true, reverse: true },

    async autocomplete(query, bias, opts?: AutocompleteOptions): Promise<Suggestion[]> {
      const limit = opts?.limit ?? 5;
      // Se piden de más porque OSM repite lugares (nodo y vía del mismo
      // sitio, homónimos en la misma comuna) y la deduplicación recorta.
      const features = await search(query, bias, limit * 2, opts?.signal);
      const mapped = features.map((f, i) => {
        const value = { ...toLocationValue(f), source: "autocomplete" as const };
        const { label, sublabel } = suggestionLabel(f);
        return { id: value.placeId ?? `photon-${i}`, label, sublabel, value };
      });
      return dedupeSuggestions(mapped).slice(0, limit);
    },

    async geocode(query, bias, opts?: RequestOptions): Promise<GeocodeOutcome | null> {
      const features = await search(query, bias, 1, opts?.signal);
      if (features.length === 0) return null;
      const value = toLocationValue(features[0]);
      return { value, matchedLevel: precisionToMatchedLevel(value.precision) };
    },

    async reverse(lat, lng, opts): Promise<LocationValue | null> {
      const url = new URL(`${base}/reverse`);
      url.searchParams.set("lat", String(lat));
      url.searchParams.set("lon", String(lng));
      if (opts?.lang && PHOTON_LANGS.has(opts.lang)) url.searchParams.set("lang", opts.lang);
      const res = await fetchWithRetry(url, { headers, signal: opts?.signal }, { signal: opts?.signal });
      if (!res.ok) throw new Error(`Photon respondió ${res.status}`);
      const body = (await res.json()) as { features?: PhotonFeature[] };
      if (!body.features || body.features.length === 0) return null;
      const value = toLocationValue(body.features[0]);
      // El punto exacto es el que se pidió, no el que "redondea" el reverse.
      return { ...value, lat, lng, source: "pin" };
    },
  };
}
